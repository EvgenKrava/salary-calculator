import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'alice') return { sub: 'sub-alice', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const ALICE = { Authorization: 'Bearer alice' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, cognitoSub: 'sub-alice' })
    .returning();
  return { app: createApp({ db, verifier }), loc, alice };
}

async function assign(app: Awaited<ReturnType<typeof seed>>['app'], body: object) {
  return app.request('/api/shifts', { method: 'POST', headers: { ...MGR, ...JSONH }, body: JSON.stringify(body) });
}

describe('manager scheduling', () => {
  it('forbids an employee from the manager list route (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/shifts', { headers: ALICE })).status).toBe(403);
  });

  it('assigns a shift (default approved) and lists it', async () => {
    const { app, loc, alice } = await seed();
    const res = await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'approved', source: 'native', employeeId: alice.id });

    const list = await app.request('/api/shifts', { headers: MGR });
    expect((await list.json())).toHaveLength(1);
  });

  it('rejects assign with unknown employee or location (400)', async () => {
    const { app, loc, alice } = await seed();
    const badEmp = await assign(app, { employeeId: '00000000-0000-0000-0000-000000000000', locationId: loc.id, workDate: '2026-08-10' });
    expect(badEmp.status).toBe(400);
    const badLoc = await assign(app, { employeeId: alice.id, locationId: '00000000-0000-0000-0000-000000000000', workDate: '2026-08-10' });
    expect(badLoc.status).toBe(400);
  });

  it('409s an assign that duplicates an employee-day', async () => {
    const { app, loc, alice } = await seed();
    await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    const dup = await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    expect(dup.status).toBe(409);
  });

  it('approves and rejects a requested shift', async () => {
    const { app, loc, alice } = await seed();
    const created = await (await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', status: 'requested' })).json() as { id: string };

    const approved = await app.request(`/api/shifts/${created.id}/approve`, { method: 'POST', headers: MGR });
    expect(approved.status).toBe(200);
    expect((await approved.json() as { status: string }).status).toBe('approved');

    const rejected = await app.request(`/api/shifts/${created.id}/reject`, { method: 'POST', headers: MGR });
    expect((await rejected.json() as { status: string }).status).toBe('rejected');
  });

  it('404s approve/delete on an unknown shift', async () => {
    const { app } = await seed();
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await app.request(`/api/shifts/${missing}/approve`, { method: 'POST', headers: MGR })).status).toBe(404);
    expect((await app.request(`/api/shifts/${missing}`, { method: 'DELETE', headers: MGR })).status).toBe(404);
  });

  it('filters the list by status', async () => {
    const { app, loc, alice } = await seed();
    await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', status: 'approved' });
    const requested = await app.request('/api/shifts?status=requested', { headers: MGR });
    expect(await requested.json()).toHaveLength(0);
    const approved = await app.request('/api/shifts?status=approved', { headers: MGR });
    expect(await approved.json()).toHaveLength(1);
  });

  it('deletes a shift', async () => {
    const { app, loc, alice } = await seed();
    const created = await (await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' })).json() as { id: string };
    const del = await app.request(`/api/shifts/${created.id}`, { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
    expect((await (await app.request('/api/shifts', { headers: MGR })).json() as unknown[])).toHaveLength(0);
  });

  it('404s approve on a malformed (non-uuid) shift id', async () => {
    const { app } = await seed();
    const res = await app.request('/api/shifts/not-a-uuid/approve', { method: 'POST', headers: MGR });
    expect(res.status).toBe(404);
  });

  it('400s the list when a date filter is malformed', async () => {
    const { app } = await seed();
    const res = await app.request('/api/shifts?from=garbage', { headers: MGR });
    expect(res.status).toBe(400);
  });
});