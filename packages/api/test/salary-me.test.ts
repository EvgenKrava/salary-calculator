import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dailyRevenue, payRates } from '../src/schema';
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

async function seedAndRun() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', opensAt: '08:00', closesAt: '16:00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, cognitoSub: 'sub-alice' })
    .returning();
  await db.insert(payRates).values({ levelId: level.id, locationId: loc.id, ratePerDay: '20.00', revenuePercent: '0.0500' });
  await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' });
  await db.insert(dailyRevenue).values({ locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved' });
  const app = createApp({ db, verifier });
  await app.request('/api/salary-runs', {
    method: 'POST',
    headers: { ...MGR, ...JSONH },
    body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
  });
  return { app, alice };
}

describe('employee pay self-view', () => {
  it("returns the caller's own pay lines with period info", async () => {
    const { app } = await seedAndRun();
    const res = await app.request('/api/salary-runs/me', { headers: ALICE });
    expect(res.status).toBe(200);
    const lines = (await res.json()) as Array<{
      periodStart: string;
      periodEnd: string;
      hourlyPay: number;
      revenueShare: number;
      total: number;
    }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-15',
      hourlyPay: 20, // full 8h working day => exactly the 20/day rate
      revenueShare: 50,
      total: 70,
    });
  });

  it('forbids a manager from the employee self-view (403)', async () => {
    const { app } = await seedAndRun();
    expect((await app.request('/api/salary-runs/me', { headers: MGR })).status).toBe(403);
  });
});