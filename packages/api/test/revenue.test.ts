import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { locations } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
  return { app: createApp({ db, verifier }), loc };
}

describe('daily revenue routes', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/revenue', { headers: EMP })).status).toBe(403);
  });

  it('creates revenue (approved/manual) and lists it', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/revenue', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, revenueDate: '2026-08-05', amount: 1234.56 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      locationId: loc.id,
      revenueDate: '2026-08-05',
      amount: 1234.56,
      source: 'manual',
      status: 'approved',
    });
    const list = await app.request('/api/revenue', { headers: MGR });
    expect(await list.json()).toHaveLength(1);
  });

  it('rejects an unknown locationId (400)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/revenue', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: '00000000-0000-0000-0000-000000000000', revenueDate: '2026-08-05', amount: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date or negative amount (400)', async () => {
    const { app, loc } = await seed();
    const badDate = await app.request('/api/revenue', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, revenueDate: '5/8/26', amount: 10 }),
    });
    expect(badDate.status).toBe(400);
    const badAmount = await app.request('/api/revenue', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, revenueDate: '2026-08-05', amount: -1 }),
    });
    expect(badAmount.status).toBe(400);
  });

  it('409s a duplicate (location, date)', async () => {
    const { app, loc } = await seed();
    const body = JSON.stringify({ locationId: loc.id, revenueDate: '2026-08-06', amount: 100 });
    await app.request('/api/revenue', { method: 'POST', headers: { ...MGR, ...JSONH }, body });
    const dup = await app.request('/api/revenue', { method: 'POST', headers: { ...MGR, ...JSONH }, body });
    expect(dup.status).toBe(409);
  });

  it('updates the amount, filters by date, and 404s unknown/malformed ids', async () => {
    const { app, loc } = await seed();
    const created = (await (
      await app.request('/api/revenue', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ locationId: loc.id, revenueDate: '2026-08-07', amount: 500 }),
      })
    ).json()) as { id: string };

    const patched = await app.request(`/api/revenue/${created.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ amount: 650.5 }),
    });
    expect(((await patched.json()) as { amount: number }).amount).toBe(650.5);

    const filtered = await app.request('/api/revenue?from=2026-08-07&to=2026-08-07', { headers: MGR });
    expect(await filtered.json()).toHaveLength(1);

    expect((await app.request('/api/revenue/not-a-uuid', { method: 'DELETE', headers: MGR })).status).toBe(404);
    expect((await app.request('/api/revenue/00000000-0000-0000-0000-000000000000', { method: 'DELETE', headers: MGR })).status).toBe(404);

    const del = await app.request(`/api/revenue/${created.id}`, { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
  });

  it('400s the list on a malformed locationId filter', async () => {
    const { app } = await seed();
    const res = await app.request('/api/revenue?locationId=not-a-uuid', { headers: MGR });
    expect(res.status).toBe(400);
  });
});