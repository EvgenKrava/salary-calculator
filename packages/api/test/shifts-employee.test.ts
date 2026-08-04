import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'alice') return { sub: 'sub-alice', groups: ['employee'] };
    if (token === 'nobody') return { sub: 'sub-none', groups: ['employee'] };
    throw new Error('bad');
  },
};
const ALICE = { Authorization: 'Bearer alice' };
const NOBODY = { Authorization: 'Bearer nobody' };
const MGR = { Authorization: 'Bearer mgr' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db, client } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', opensAt: '08:00', closesAt: '16:00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, cognitoSub: 'sub-alice' })
    .returning();
  const app = createApp({ db, verifier });
  return { app, db, client, loc, alice };
}

describe('employee scheduling', () => {
  it('lets an employee request a shift (status requested)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(201);
    const shift = await res.json();
    expect(shift).toMatchObject({ locationId: loc.id, workDate: '2026-08-10', status: 'requested', source: 'native' });
  });

  it('rejects a request for a caller with no employee profile (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...NOBODY, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(403);
  });

  it('forbids a manager from the employee request route (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown locationId with 400', async () => {
    const { app } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: '00000000-0000-0000-0000-000000000000', workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a badly-formatted workDate with 400', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '08/10/2026' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s a second request on the same day', async () => {
    const { app, loc } = await seed();
    const body = JSON.stringify({ locationId: loc.id, workDate: '2026-08-11' });
    await app.request('/api/shifts/requests', { method: 'POST', headers: { ...ALICE, ...JSONH }, body });
    const res = await app.request('/api/shifts/requests', { method: 'POST', headers: { ...ALICE, ...JSONH }, body });
    expect(res.status).toBe(409);
  });

  it("lists only the caller's own shifts", async () => {
    const { app, loc } = await seed();
    await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-12' }),
    });
    const res = await app.request('/api/shifts/me', { headers: ALICE });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ workDate: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].workDate).toBe('2026-08-12');
  });

  it('ignores a body-injected employeeId (identity comes from the token)', async () => {
    const { app, loc, alice } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-13', employeeId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as { employeeId: string }).employeeId).toBe(alice.id);
  });

  it('forbids a deactivated employee from self-service (403)', async () => {
    const { app, db, loc, alice } = await seed();
    await db.update(employees).set({ active: false }).where(eq(employees.id, alice.id));
    const res = await app.request('/api/shifts/me', { headers: ALICE });
    expect(res.status).toBe(403);
  });

  it('defaults the shift window to the location hours', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-14' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ startsAt: '08:00', endsAt: '16:00' });
  });

  it('rejects an inverted window (400)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-15', startsAt: '16:00', endsAt: '08:00' }),
    });
    expect(res.status).toBe(400);
  });
});