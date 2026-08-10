import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'admin') return { sub: 'u-admin', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const ADMIN = { Authorization: 'Bearer admin' };
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

interface PayRateDto {
  levelId: string;
  locationId: string;
  ratePerDay: number;
  revenuePercent: number;
}

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L' }).returning();
  const [location] = await db.insert(locations).values({ name: 'A', opensAt: '08:00', closesAt: '16:00' }).returning();
  return { app: createApp({ db, verifier }), levelId: level.id, locationId: location.id };
}

describe('pay-rates routes', () => {
  it('upserts a cell and reads it back', async () => {
    const { app, levelId, locationId } = await seed();
    const put = await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 600, revenuePercent: 0.05 }),
    });
    expect(put.status).toBe(200);
    const list = (await (await app.request('/api/pay-rates', { headers: MGR })).json()) as PayRateDto[];
    expect(list).toEqual([{ levelId, locationId, ratePerDay: 600, revenuePercent: 0.05 }]);

    // Upsert: PUT again with a new rate, still exactly one row.
    await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 650 }),
    });
    const after = (await (await app.request('/api/pay-rates', { headers: MGR })).json()) as PayRateDto[];
    // The second PUT omitted revenuePercent, so the zod default (0) applies on upsert — the
    // PUT body is the full cell state, not a patch, so the old 0.05 does not survive.
    expect(after).toEqual([{ levelId, locationId, ratePerDay: 650, revenuePercent: 0 }]);
  });

  it('percent defaults to 0 when omitted', async () => {
    const { app, levelId, locationId } = await seed();
    const put = await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 600 }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as PayRateDto).revenuePercent).toBe(0);
  });

  it('rejects out-of-range values with 400', async () => {
    const { app, levelId, locationId } = await seed();
    const negRate = await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: -1 }),
    });
    expect(negRate.status).toBe(400);

    const badPercent = await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 600, revenuePercent: 1.5 }),
    });
    expect(badPercent.status).toBe(400);
  });

  it('manager can read but not write', async () => {
    const { app, levelId, locationId } = await seed();
    expect((await app.request('/api/pay-rates', { headers: MGR })).status).toBe(200);
    const put = await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 600 }),
    });
    expect(put.status).toBe(403);
    const del = await app.request(`/api/pay-rates?levelId=${levelId}&locationId=${locationId}`, {
      method: 'DELETE',
      headers: MGR,
    });
    expect(del.status).toBe(403);
  });

  it('employee can do neither', async () => {
    const { app } = await seed();
    expect((await app.request('/api/pay-rates', { headers: EMP })).status).toBe(403);
  });

  it('deletes a cell', async () => {
    const { app, levelId, locationId } = await seed();
    await app.request('/api/pay-rates', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ levelId, locationId, ratePerDay: 600 }),
    });
    const del = await app.request(`/api/pay-rates?levelId=${levelId}&locationId=${locationId}`, {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    const again = await app.request(`/api/pay-rates?levelId=${levelId}&locationId=${locationId}`, {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(await again.json()).toEqual({ deleted: false });

    const missingParams = await app.request('/api/pay-rates', { method: 'DELETE', headers: ADMIN });
    expect(missingParams.status).toBe(400);
  });
});
