import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dailyRevenue } from '../src/schema';
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

interface RunLineDto {
  employeeId: string;
  hourlyPay: number;
  revenueShare: number;
  bonus: number;
  total: number;
}
interface RunDto {
  id: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  lines: RunLineDto[];
}
interface BlockedDto {
  error: string;
  gaps: Array<{ employeeId: string; locationId: string; date: string }>;
}

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', opensAt: '08:00', closesAt: '16:00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, revenuePercent: '0.0500', cognitoSub: 'sub-alice' })
    .returning();
  return { db, app: createApp({ db, verifier }), loc, alice };
}

describe('salary runs', () => {
  it('forbids an employee from creating a run (403)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...EMP, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('blocks (409) with gaps when a worked day has no approved revenue', async () => {
    const { db, app, loc, alice } = await seed();
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' });
    // no revenue for 2026-08-03
    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as BlockedDto;
    expect(body.gaps).toEqual([{ employeeId: alice.id, locationId: loc.id, date: '2026-08-03' }]);
    // run not persisted
    const list = await app.request('/api/salary-runs', { headers: MGR });
    expect(await list.json()).toHaveLength(0);
  });

  it('computes and persists a run, applying a bonus', async () => {
    const { db, app, loc, alice } = await seed();
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' });
    await db.insert(dailyRevenue).values({ locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved' });

    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1, bonuses: { [alice.id]: 25 } }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as RunDto;
    expect(run).toMatchObject({ periodStart: '2026-08-01', periodEnd: '2026-08-15' });
    const line = run.lines.find((l) => l.employeeId === alice.id);
    // Day rate 20, full 8h working day => 20. Total 20 + 50 + 25.
    expect(line).toEqual({ employeeId: alice.id, hourlyPay: 20, revenueShare: 50, bonus: 25, total: 95 });

    const got = await app.request(`/api/salary-runs/${run.id}`, { headers: MGR });
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as RunDto;
    expect(gotBody.lines).toHaveLength(1);
    expect(gotBody.lines[0]).toEqual({ employeeId: alice.id, hourlyPay: 20, revenueShare: 50, bonus: 25, total: 95 });
  });

  it('409s a second run for the same period', async () => {
    const { db, app, loc, alice } = await seed();
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' });
    await db.insert(dailyRevenue).values({ locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved' });
    const body = JSON.stringify({ year: 2026, month: 8, half: 1 });
    await app.request('/api/salary-runs', { method: 'POST', headers: { ...MGR, ...JSONH }, body });
    const dup = await app.request('/api/salary-runs', { method: 'POST', headers: { ...MGR, ...JSONH }, body });
    expect(dup.status).toBe(409);
  });

  it('validates the period selector (400)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 13, half: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a negative bonus (400)', async () => {
    const { app, alice } = await seed();
    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1, bonuses: { [alice.id]: -10 } }),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown run id', async () => {
    const { app } = await seed();
    expect((await app.request('/api/salary-runs/00000000-0000-0000-0000-000000000000', { headers: MGR })).status).toBe(404);
  });

  it('prorates revenue share across a split day', async () => {
    const { db, app, loc, alice } = await seed();
    const [level] = await db.select().from(levels);
    const [bob] = await db
      .insert(employees)
      .values({ name: 'Bob', levelId: level.id, revenuePercent: '0.0500', cognitoSub: 'sub-bob' })
      .returning();
    await db.insert(shifts).values([
      { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '08:00', endsAt: '12:00', status: 'approved', source: 'native' },
      { employeeId: bob.id, locationId: loc.id, workDate: '2026-08-03', startsAt: '12:00', endsAt: '16:00', status: 'approved', source: 'native' },
    ]);
    await db.insert(dailyRevenue).values({ locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved' });

    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as RunDto;
    const aliceLine = run.lines.find((l) => l.employeeId === alice.id);
    const bobLine = run.lines.find((l) => l.employeeId === bob.id);
    // each worked 4 of the day's 8 hours => half of their own 5%
    expect(aliceLine).toMatchObject({ hourlyPay: 10, revenueShare: 25 });
    expect(bobLine).toMatchObject({ hourlyPay: 10, revenueShare: 25 });
  });
});
describe('salary run preview', () => {
  it('returns the same figures the commit would write, without persisting', async () => {
    // A run is final and immediately visible to employees, so a manager must see the exact
    // numbers first. Preview and commit share one code path precisely so the previewed figure
    // cannot differ from the figure paid.
    const { app, db, loc, alice } = await seed();
    await db.insert(shifts).values({
      employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03',
      startsAt: '08:00:00', endsAt: '16:00:00', status: 'approved', source: 'native',
    });
    await db.insert(dailyRevenue).values({
      locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved',
    });
    const body = JSON.stringify({ year: 2026, month: 8, half: 1, bonuses: {} });

    const pre = await app.request('/api/salary-runs/preview', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body,
    });
    expect(pre.status).toBe(200);
    const preview = (await pre.json()) as { lines: unknown[]; blocked: boolean; periodStart: string };
    expect(preview.blocked).toBe(false);
    expect(preview.periodStart).toBe('2026-08-01');

    // Nothing was written.
    expect(await (await app.request('/api/salary-runs', { headers: MGR })).json()).toHaveLength(0);

    // Committing now yields identical lines.
    const post = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body,
    });
    expect(post.status).toBe(201);
    const committed = (await post.json()) as { lines: unknown[] };
    expect(committed.lines).toEqual(preview.lines);
  });

  it('reports gaps as a 200, so a preview can show what is missing', async () => {
    // The commit route 409s on gaps because refusing to write IS the failure there. For a
    // preview, "here is what is missing" is a successful answer.
    // A gap needs a WORKED day with no approved revenue; the seed has neither shifts nor
    // revenue, so deleting revenue alone would produce nothing to report.
    const { app, db, loc, alice } = await seed();
    await db.insert(shifts).values({
      employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03',
      startsAt: '08:00:00', endsAt: '16:00:00', status: 'approved', source: 'native',
    });
    const res = await app.request('/api/salary-runs/preview', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocked: boolean; gaps: unknown[] };
    expect(body.blocked).toBe(true);
    expect(body.gaps.length).toBeGreaterThan(0);
  });

  it('forbids an employee from previewing the whole payroll (403)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/salary-runs/preview', {
      method: 'POST',
      headers: { ...EMP, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(403);
  });
});
