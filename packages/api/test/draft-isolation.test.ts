import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dailyRevenue, payRates } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

/**
 * A draft shift lives in `shifts`, so every payroll read must filter status. The failure mode
 * this file exists to prevent is a draft shift reaching a payslip.
 *
 * `/api/shifts/me` had NO status filter before this task — it leaked `rejected` shifts to
 * employees already, and would have leaked half-built schedules.
 */
const EMPLOYEE_SUB = 'sub-emp';

const verifier: TokenVerifier = {
  async verify(token: string) {
    if (token === 'mgr') return { sub: 'sub-mgr', email: 'm@x', groups: ['manager'] };
    return { sub: EMPLOYEE_SUB, email: 'e@x', groups: ['employee'] };
  },
};

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L' }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ name: '1', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  const [emp] = await db
    .insert(employees)
    .values({ name: 'Олена', levelId: level.id, cognitoSub: EMPLOYEE_SUB })
    .returning();
  await db.insert(payRates).values({ levelId: level.id, locationId: loc.id, ratePerDay: '600.00', revenuePercent: '0.0500' });
  return { db, app: createApp({ db, verifier }), loc, emp };
}

describe('draft isolation', () => {
  it('does not show a draft shift to the employee it belongs to', async () => {
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values([
      { employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01', startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft' },
      { employeeId: emp.id, locationId: loc.id, workDate: '2026-09-02', startsAt: '08:00:00', endsAt: '14:00:00', status: 'approved' },
    ]);

    const res = await app.request('/api/shifts/me', { headers: { Authorization: 'Bearer emp' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workDate: string; status: string }[];
    expect(body.map((s) => s.workDate)).toEqual(['2026-09-02']);
  });

  it('does not show a rejected shift either — the pre-existing leak', async () => {
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values({
      employeeId: emp.id, locationId: loc.id, workDate: '2026-09-03',
      startsAt: '08:00:00', endsAt: '14:00:00', status: 'rejected',
    });
    const res = await app.request('/api/shifts/me', { headers: { Authorization: 'Bearer emp' } });
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it('does show a requested shift — it is still awaiting a decision, not draft or rejected', async () => {
    // The fix for the draft/rejected leak must not narrow the filter down to `approved` only:
    // a `requested` shift is the employee's own pending request and they need to see it on
    // /me while it awaits a manager's decision.
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values({
      employeeId: emp.id, locationId: loc.id, workDate: '2026-09-05',
      startsAt: '08:00:00', endsAt: '14:00:00', status: 'requested',
    });
    const res = await app.request('/api/shifts/me', { headers: { Authorization: 'Bearer emp' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workDate: string }[];
    expect(body.map((s) => s.workDate)).toEqual(['2026-09-05']);
  });

  it('never counts a draft shift in a salary run', async () => {
    const { db, app, loc, emp } = await seed();
    await db.insert(dailyRevenue).values({
      locationId: loc.id, revenueDate: '2026-09-01', amount: '1000.00',
      source: 'manual', status: 'approved',
    });
    await db.insert(shifts).values({
      employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01',
      startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft',
    });

    const res = await app.request('/api/salary-runs/preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer mgr', 'content-type': 'application/json' },
      body: JSON.stringify({ year: 2026, month: 9, half: 1, bonuses: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { total: number }[]; blocked: boolean };
    /*
     * A draft shift means no hours worked, so the person earns nothing from it. Asserted as
     * "every line totals zero" rather than "no lines": the run emits a line per active employee
     * regardless, and a blocked period still returns 200 with gaps (see salaryRuns.ts:153) — so
     * asserting on `lines.length` would pass for the wrong reason.
     */
    expect(body.lines.every((l) => l.total === 0)).toBe(true);
  });

  it('lets a real shift be created on a day that already holds a draft', async () => {
    // A draft must not block a real shift — otherwise a half-built schedule makes the day
    // editor and the import both report a phantom conflict.
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values({
      employeeId: emp.id, locationId: loc.id, workDate: '2026-09-04',
      startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft',
    });

    const res = await app.request('/api/shifts', {
      method: 'POST',
      headers: { Authorization: 'Bearer mgr', 'content-type': 'application/json' },
      body: JSON.stringify({
        employeeId: emp.id, locationId: loc.id, workDate: '2026-09-04',
        startsAt: '09:00', endsAt: '15:00',
      }),
    });
    expect(res.status).toBe(201);
  });

  it('lets a manager filter the list down to drafts', async () => {
    // The schedule grid needs this to show a manager only the month they are still building.
    // The whitelist used to omit `draft`, and an unrecognised status fell through silently and
    // returned every shift regardless of status.
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values([
      { employeeId: emp.id, locationId: loc.id, workDate: '2026-09-06', startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft' },
      { employeeId: emp.id, locationId: loc.id, workDate: '2026-09-07', startsAt: '08:00:00', endsAt: '14:00:00', status: 'approved' },
    ]);
    const res = await app.request('/api/shifts?status=draft', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workDate: string; status: string }[];
    expect(body.map((s) => s.workDate)).toEqual(['2026-09-06']);
  });

  it('400s the manager list on an unrecognised status filter', async () => {
    const { app } = await seed();
    const res = await app.request('/api/shifts?status=bogus', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(400);
  });

  it('every employee-facing and payroll shifts query filters on status', async () => {
    /*
     * A source-level assertion, because it is the only kind that can catch the NEXT query
     * someone adds without a filter — the actual failure mode, which no runtime test can see
     * because the query does not exist yet.
     *
     * Scoped to the two query shapes where a missing filter LEAKS or MISPAYS, rather than to
     * every `.from(shifts)`. A blanket rule flags four call sites today and only one is a bug:
     * the idempotency lookup, the manager list, and the fetch-by-id in `/:id/approve` are all
     * correct without a literal `shifts.status` in the statement. The manager list now accepts
     * an explicit `?status=draft` filter and 400s on anything else unrecognised (see the tests
     * below) — but leaving the filter off is still a manager choosing to see every shift
     * including drafts, which is correct for that role and not a leak this scan needs to catch.
     * A test that fails on correct code gets deleted by the next person, taking the real guard
     * with it.
     *
     * The two shapes that matter:
     *   - `employees.cognitoSub` / `employeeId` scoping → an employee reading their own data
     *   - anything in salaryRuns.ts → payroll arithmetic
     */
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // `dirname(fileURLToPath(import.meta.url))`, matching test/bundle.test.ts.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/routes');

    const offenders: string[] = [];
    for (const file of ['shifts.ts', 'salaryRuns.ts']) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const stmt of src.split(';')) {
        if (!stmt.includes('.from(shifts)')) continue;
        const isPayroll = file === 'salaryRuns.ts';
        const isSelfScoped = stmt.includes('currentEmployee') || stmt.includes('employee.id');
        if (!isPayroll && !isSelfScoped) continue;
        if (!stmt.includes('shifts.status')) offenders.push(`${file}: ${stmt.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
