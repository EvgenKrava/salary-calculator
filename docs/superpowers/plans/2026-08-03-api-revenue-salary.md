# API Revenue & Salary-Run Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the API — manager-entered daily revenue CRUD, the one-shot salary-calculation run that wires in `@salary/core`'s `calculateSalaries` (honoring the blocker rule and persisting an immutable run), manager run views, and an employee self-view of their pay.

**Architecture:** Two new route groups mounted in `createApp`: `createRevenueRoutes(db)` at `/api/revenue` (manager/admin CRUD) and `createSalaryRunRoutes(db)` at `/api/salary-runs`. The salary-run POST loads active employees, levels, locations, approved in-period shifts, and approved daily revenue; maps the string-typed DB rows to `@salary/core`'s number-typed `CalcInput`; calls `calculateSalaries`; returns `409` with the gaps if `blocked`; otherwise persists `salary_runs` + `salary_run_lines` in one transaction. The domain math lives entirely in `@salary/core` — this plan only loads/maps/persists.

**Tech Stack:** Hono, Drizzle ORM, Zod, Vitest, `@salary/core` — all present.

## Global Constraints

- **Node** `>=20`, **pnpm**; work only in `packages/api`. TypeScript strict, ESM, extensionless relative imports.
- **Role gating:** revenue and salary-run management → `requireRole('manager', 'admin')`; the employee pay self-view → `requireRole('employee')`.
- **NUMERIC as number at the API boundary** (String on write, `Number(...)` on read). Reuse the shared helpers `readJson`/`getOr404` (`src/http/validation.ts`), `isUniqueViolation` (`src/http/dbErrors.ts`), and `currentEmployee` (`src/http/employeeContext.ts`).
- **Never re-implement domain logic.** The run endpoint calls `@salary/core`'s `calculateSalaries` and `payPeriodsForMonth`; hourly/revenue-share/rounding/blocker rules come from there.
- **Blocker rule (design §3):** if `calculateSalaries` returns `blocked` (a worked location-day has no approved revenue), the run is NOT persisted; return `409` with the `gaps`.
- **One-shot immutable runs:** `salary_runs` has UNIQUE(period_start, period_end); a duplicate period → `409`. Pay periods are 1st–15th and 16th–end (via `payPeriodsForMonth`).
- **Manual revenue is `status='approved'`, `source='manual'`.** Unknown location → `400`; duplicate (location, date) → `409`; unknown id → `404`; malformed id → `404`; bad payload → `400`.

---

### Task 1: Daily revenue CRUD (manager)

**Files:**
- Create: `packages/api/src/routes/revenue.ts`
- Modify: `packages/api/src/app.ts` (mount)
- Test: `packages/api/test/revenue.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppEnv`/`requireRole`, `readJson`/`getOr404`, `isUniqueViolation`, the `dailyRevenue`/`locations` tables, drizzle `and`/`eq`/`gte`/`lte`/`SQL`.
- Produces: `createRevenueRoutes(db: Db): Hono<AppEnv>` at `/api/revenue`. DTO: `{ id, locationId, revenueDate, amount: number, source, status }`.

- [ ] **Step 1: Write the failing revenue test**

`packages/api/test/revenue.test.ts`:
```ts
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
    const created = await (
      await app.request('/api/revenue', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ locationId: loc.id, revenueDate: '2026-08-07', amount: 500 }),
      })
    ).json();

    const patched = await app.request(`/api/revenue/${created.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ amount: 650.5 }),
    });
    expect((await patched.json()).amount).toBe(650.5);

    const filtered = await app.request('/api/revenue?from=2026-08-07&to=2026-08-07', { headers: MGR });
    expect(await filtered.json()).toHaveLength(1);

    expect((await app.request('/api/revenue/not-a-uuid', { method: 'DELETE', headers: MGR })).status).toBe(404);
    expect((await app.request('/api/revenue/00000000-0000-0000-0000-000000000000', { method: 'DELETE', headers: MGR })).status).toBe(404);

    const del = await app.request(`/api/revenue/${created.id}`, { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test revenue`
Expected: FAIL — routes not mounted / `../src/routes/revenue` missing.

- [ ] **Step 3: Implement the revenue routes**

`packages/api/src/routes/revenue.ts`:
```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { isUniqueViolation } from '../http/dbErrors';
import { dailyRevenue, locations } from '../schema';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const createSchema = z.object({
  locationId: z.string().uuid(),
  revenueDate: dateString,
  amount: z.number().nonnegative(),
});
const updateSchema = z.object({ amount: z.number().nonnegative() });

type RevenueRow = typeof dailyRevenue.$inferSelect;
function toDto(row: RevenueRow) {
  return {
    id: row.id,
    locationId: row.locationId,
    revenueDate: row.revenueDate,
    amount: Number(row.amount),
    source: row.source,
    status: row.status,
  };
}

export function createRevenueRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'revenue entry not found' });
    return id;
  }

  routes.get('/', async (c) => {
    const filters: SQL[] = [];
    const locationId = c.req.query('locationId');
    if (locationId && z.string().uuid().safeParse(locationId).success) filters.push(eq(dailyRevenue.locationId, locationId));
    const from = c.req.query('from');
    if (from !== undefined) {
      if (!dateString.safeParse(from).success) throw new HTTPException(400, { message: 'invalid "from" date' });
      filters.push(gte(dailyRevenue.revenueDate, from));
    }
    const to = c.req.query('to');
    if (to !== undefined) {
      if (!dateString.safeParse(to).success) throw new HTTPException(400, { message: 'invalid "to" date' });
      filters.push(lte(dailyRevenue.revenueDate, to));
    }
    const rows = filters.length
      ? await db.select().from(dailyRevenue).where(and(...filters))
      : await db.select().from(dailyRevenue);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const rows = await db.select().from(dailyRevenue).where(eq(dailyRevenue.id, id));
    return c.json(toDto(getOr404(rows, 'revenue entry not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const loc = await db.select().from(locations).where(eq(locations.id, body.locationId));
    if (loc.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
    try {
      const [row] = await db
        .insert(dailyRevenue)
        .values({ locationId: body.locationId, revenueDate: body.revenueDate, amount: String(body.amount), source: 'manual', status: 'approved' })
        .returning();
      return c.json(toDto(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'revenue already recorded for that location and day' });
      throw err;
    }
  });

  routes.patch('/:id', async (c) => {
    const id = idParam(c);
    const body = await readJson(c, updateSchema);
    const [row] = await db
      .update(dailyRevenue)
      .set({ amount: String(body.amount) })
      .where(eq(dailyRevenue.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'revenue entry not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const id = idParam(c);
    const [row] = await db.delete(dailyRevenue).where(eq(dailyRevenue.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'revenue entry not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
```

- [ ] **Step 4: Mount in `createApp`**

In `packages/api/src/app.ts`, add after the shifts import:
```ts
import { createRevenueRoutes } from './routes/revenue';
```
And after the `app.route('/api/shifts', ...)` line:
```ts
  app.route('/api/revenue', createRevenueRoutes(deps.db));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test revenue`
Expected: PASS — all revenue tests green.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/revenue.ts packages/api/src/app.ts packages/api/test/revenue.test.ts
git commit -m "Add manager daily-revenue CRUD routes"
```

---

### Task 2: Salary-run endpoint + manager views

**Files:**
- Create: `packages/api/src/routes/salaryRuns.ts`
- Modify: `packages/api/src/app.ts` (mount)
- Test: `packages/api/test/salary-runs.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppEnv`/`requireRole`, `readJson`/`getOr404`, `isUniqueViolation`, `@salary/core` (`calculateSalaries`, `payPeriodsForMonth`, `type CalcInput`), the `employees`/`levels`/`locations`/`shifts`/`dailyRevenue`/`salaryRuns`/`salaryRunLines` tables.
- Produces: `createSalaryRunRoutes(db: Db): Hono<AppEnv>` at `/api/salary-runs` with `POST /`, `GET /`, `GET /:id`. Run DTO: `{ id, periodStart, periodEnd, createdAt }`; line DTO: `{ employeeId, hourlyPay, revenueShare, bonus, total }` (numbers).

- [ ] **Step 1: Write the failing salary-run test**

`packages/api/test/salary-runs.test.ts`:
```ts
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

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
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
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', status: 'approved', source: 'native' });
    // no revenue for 2026-08-03
    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.gaps).toEqual([{ employeeId: alice.id, locationId: loc.id, date: '2026-08-03' }]);
    // run not persisted
    const list = await app.request('/api/salary-runs', { headers: MGR });
    expect(await list.json()).toHaveLength(0);
  });

  it('computes and persists a run, applying a bonus', async () => {
    const { db, app, loc, alice } = await seed();
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', status: 'approved', source: 'native' });
    await db.insert(dailyRevenue).values({ locationId: loc.id, revenueDate: '2026-08-03', amount: '1000.00', source: 'manual', status: 'approved' });

    const res = await app.request('/api/salary-runs', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ year: 2026, month: 8, half: 1, bonuses: { [alice.id]: 25 } }),
    });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({ periodStart: '2026-08-01', periodEnd: '2026-08-15' });
    const line = run.lines.find((l: { employeeId: string }) => l.employeeId === alice.id);
    expect(line).toEqual({ employeeId: alice.id, hourlyPay: 160, revenueShare: 50, bonus: 25, total: 235 });

    const got = await app.request(`/api/salary-runs/${run.id}`, { headers: MGR });
    expect(got.status).toBe(200);
    expect((await got.json()).lines).toHaveLength(1);
  });

  it('409s a second run for the same period', async () => {
    const { db, app, loc, alice } = await seed();
    await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', status: 'approved', source: 'native' });
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

  it('404s an unknown run id', async () => {
    const { app } = await seed();
    expect((await app.request('/api/salary-runs/00000000-0000-0000-0000-000000000000', { headers: MGR })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test salary-runs`
Expected: FAIL — routes not mounted / file missing.

- [ ] **Step 3: Implement the salary-run routes**

`packages/api/src/routes/salaryRuns.ts`:
```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { calculateSalaries, payPeriodsForMonth, type CalcInput } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { isUniqueViolation } from '../http/dbErrors';
import { employees, levels, locations, shifts, dailyRevenue, salaryRuns, salaryRunLines } from '../schema';

const createSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  half: z.union([z.literal(1), z.literal(2)]),
  bonuses: z.record(z.string(), z.number()).optional(),
});

type RunRow = typeof salaryRuns.$inferSelect;
function runDto(row: RunRow) {
  return { id: row.id, periodStart: row.periodStart, periodEnd: row.periodEnd, createdAt: row.createdAt };
}
type LineRow = typeof salaryRunLines.$inferSelect;
function lineDto(row: LineRow) {
  return {
    employeeId: row.employeeId,
    hourlyPay: Number(row.hourlyPay),
    revenueShare: Number(row.revenueShare),
    bonus: Number(row.bonus),
    total: Number(row.total),
  };
}

export function createSalaryRunRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'run not found' });
    return id;
  }

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const [first, second] = payPeriodsForMonth(body.year, body.month);
    const period = body.half === 1 ? first : second;

    const [emps, lvls, locs, shfts, revs] = await Promise.all([
      db.select().from(employees),
      db.select().from(levels),
      db.select().from(locations),
      db
        .select()
        .from(shifts)
        .where(and(eq(shifts.status, 'approved'), gte(shifts.workDate, period.start), lte(shifts.workDate, period.end))),
      db.select().from(dailyRevenue).where(eq(dailyRevenue.status, 'approved')),
    ]);

    const input: CalcInput = {
      employees: emps.map((e) => ({
        id: e.id,
        name: e.name,
        levelId: e.levelId,
        revenuePercent: Number(e.revenuePercent),
        cognitoSub: e.cognitoSub,
        active: e.active,
      })),
      levels: lvls.map((l) => ({ id: l.id, name: l.name, ratePerHour: Number(l.ratePerHour) })),
      locations: locs.map((l) => ({ id: l.id, name: l.name, standardShiftHours: Number(l.standardShiftHours) })),
      shifts: shfts.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        locationId: s.locationId,
        workDate: s.workDate,
        status: s.status,
        source: s.source,
      })),
      dailyRevenue: revs.map((r) => ({
        locationId: r.locationId,
        revenueDate: r.revenueDate,
        amount: Number(r.amount),
        status: r.status,
      })),
      bonuses: body.bonuses ?? {},
    };

    const result = calculateSalaries(input, period);
    if (result.blocked) {
      return c.json({ error: 'revenue data incomplete for the period', gaps: result.gaps }, 409);
    }

    try {
      const run = await db.transaction(async (tx) => {
        const [runRow] = await tx
          .insert(salaryRuns)
          .values({ periodStart: period.start, periodEnd: period.end, createdBy: c.get('principal').sub })
          .returning();
        if (result.lines.length > 0) {
          await tx.insert(salaryRunLines).values(
            result.lines.map((l) => ({
              runId: runRow.id,
              employeeId: l.employeeId,
              hourlyPay: String(l.hourlyPay),
              revenueShare: String(l.revenueShare),
              bonus: String(l.bonus),
              total: String(l.total),
            })),
          );
        }
        return runRow;
      });
      return c.json({ ...runDto(run), lines: result.lines }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'a salary run already exists for this period' });
      throw err;
    }
  });

  routes.get('/', async (c) => {
    const rows = await db.select().from(salaryRuns);
    return c.json(rows.map(runDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const runs = await db.select().from(salaryRuns).where(eq(salaryRuns.id, id));
    const run = getOr404(runs, 'run not found');
    const lines = await db.select().from(salaryRunLines).where(eq(salaryRunLines.runId, id));
    return c.json({ ...runDto(run), lines: lines.map(lineDto) });
  });

  return routes;
}
```

Note on `db.transaction`: the Drizzle PGlite driver (tests) and the RDS Data API driver (prod) both support `.transaction(async (tx) => ...)`. If the shared `Db` type does not expose `.transaction` after the documented cast, insert the run then the lines sequentially instead and report it as a concern — the duplicate-period UNIQUE guard makes a partially-written run unreachable in the common path, but the transaction is preferred for atomicity.

- [ ] **Step 4: Mount in `createApp`**

In `packages/api/src/app.ts`, add after the revenue import:
```ts
import { createSalaryRunRoutes } from './routes/salaryRuns';
```
And after the `app.route('/api/revenue', ...)` line:
```ts
  app.route('/api/salary-runs', createSalaryRunRoutes(deps.db));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test salary-runs`
Expected: PASS — all salary-run tests green (blocker 409 with gaps, happy-path totals 160/50/25/235, duplicate-period 409, period validation 400, unknown id 404).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/salaryRuns.ts packages/api/src/app.ts packages/api/test/salary-runs.test.ts
git commit -m "Add salary-run calculation endpoint and manager run views"
```

---

### Task 3: Employee pay self-view

**Files:**
- Modify: `packages/api/src/routes/salaryRuns.ts` (add employee `GET /me`)
- Test: `packages/api/test/salary-me.test.ts`

**Interfaces:**
- Consumes: `currentEmployee`, the `salaryRuns`/`salaryRunLines` tables.
- Produces: `GET /api/salary-runs/me` (gated `employee`) returning the caller's lines across runs: `{ runId, periodStart, periodEnd, hourlyPay, revenueShare, bonus, total }[]`.

- [ ] **Step 1: Write the failing self-view test**

`packages/api/test/salary-me.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dailyRevenue } from '../src/schema';
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
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, revenuePercent: '0.0500', cognitoSub: 'sub-alice' })
    .returning();
  await db.insert(shifts).values({ employeeId: alice.id, locationId: loc.id, workDate: '2026-08-03', status: 'approved', source: 'native' });
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
  it('returns the caller’s own pay lines with period info', async () => {
    const { app } = await seedAndRun();
    const res = await app.request('/api/salary-runs/me', { headers: ALICE });
    expect(res.status).toBe(200);
    const lines = await res.json();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-15',
      hourlyPay: 160,
      revenueShare: 50,
      total: 210,
    });
  });

  it('forbids a manager from the employee self-view (403)', async () => {
    const { app } = await seedAndRun();
    expect((await app.request('/api/salary-runs/me', { headers: MGR })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test salary-me`
Expected: FAIL — `GET /me` not implemented (manager-gated group returns 403 for the employee, or route missing).

- [ ] **Step 3: Add the employee `GET /me` route**

In `packages/api/src/routes/salaryRuns.ts`:

Add the import:
```ts
import { currentEmployee } from '../http/employeeContext';
```
Register `GET /me` with employee gating **before** the manager `routes.use('*', requireRole('manager', 'admin'))` line, so the blanket manager guard does not apply to it. Place it as the first route in `createSalaryRunRoutes`, immediately after `const routes = new Hono<AppEnv>();`:
```ts
  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const rows = await db
      .select({
        runId: salaryRunLines.runId,
        periodStart: salaryRuns.periodStart,
        periodEnd: salaryRuns.periodEnd,
        hourlyPay: salaryRunLines.hourlyPay,
        revenueShare: salaryRunLines.revenueShare,
        bonus: salaryRunLines.bonus,
        total: salaryRunLines.total,
      })
      .from(salaryRunLines)
      .innerJoin(salaryRuns, eq(salaryRunLines.runId, salaryRuns.id))
      .where(eq(salaryRunLines.employeeId, employee.id));
    return c.json(
      rows.map((r) => ({
        runId: r.runId,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        hourlyPay: Number(r.hourlyPay),
        revenueShare: Number(r.revenueShare),
        bonus: Number(r.bonus),
        total: Number(r.total),
      })),
    );
  });
```
IMPORTANT ordering: because the manager `routes.use('*', requireRole('manager','admin'))` middleware is registered after this `GET /me` handler, it must NOT run for `/me`. In Hono, a `use('*')` registered after a route still applies to later-matched requests unless the earlier handler terminates. To guarantee isolation, register `GET /me` **and its `requireRole('employee')`** before the `routes.use('*', requireRole('manager','admin'))` line AND confirm via the test that a manager gets 403 on `/me` while an employee gets 200. If the blanket `use` still intercepts `/me` (manager 200 / employee 403 — inverted), instead scope the manager guard to the specific manager routes (attach `requireRole('manager','admin')` per-route on `POST /`, `GET /`, `GET /:id`) rather than a blanket `use('*')`. The test in Step 1 is the arbiter.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test salary-me`
Then: `pnpm --filter @salary/api test salary-runs`
Expected: PASS — self-view returns the caller's line (hourlyPay 160, revenueShare 50, total 210), manager forbidden (403); manager run tests still green.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm --filter @salary/api test` → all green.
Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/salaryRuns.ts packages/api/test/salary-me.test.ts
git commit -m "Add employee salary self-view endpoint"
```

---

## Self-Review

**Spec coverage (design §3, §4):**
- Manager records daily revenue (manual/approved) → Task 1.
- One-shot calc run wiring `@salary/core` → Task 2 (`calculateSalaries` + `payPeriodsForMonth`; no domain logic re-implemented).
- Blocker rule (missing approved revenue → not persisted, gaps returned) → Task 2 (`result.blocked` → 409 with gaps; test asserts run not persisted).
- Immutable, unique-per-period runs → Task 2 (UNIQUE(period_start, period_end) → 409 via `isUniqueViolation`).
- Per-employee bonus at run time → Task 2 (`bonuses` map into `CalcInput`; test asserts bonus in total).
- Persisted breakdown snapshot → `salary_run_lines` insert in Task 2's transaction.
- Employee self-view of own pay → Task 3 (`GET /me`, gated employee, own lines only).
- NUMERIC boundary (String write / Number read) throughout; ids validated (malformed → 404); role gating per design §2.

**Placeholder scan:** No TBD/TODO. The `db.transaction` fallback and the `/me` route-ordering contingency are explicit, test-arbitrated instructions, not placeholders.

**Type consistency:** `CalcInput` mapping converts every numeric DB string to a number and passes enum-typed `status`/`source` straight through (they match `@salary/core`'s unions); `result.lines` (EmployeeBreakdown, numbers) are returned directly on create and re-derived via `Number(...)` on read; `Db`, `AppEnv`, shared helpers reused; each route group mounted once.
---

## Post-Review Polish (applied after the whole-branch review — verdict was "ready to merge")

All Minor, no correctness/security impact:
1. `GET /api/revenue` — a present-but-malformed `locationId` query param now returns `400` (was silently ignored → unfiltered results), matching the `from`/`to` date-filter contract.
2. Salary-run `bonuses` values constrained to `z.number().nonnegative()` (matches the `amount` validation; negative bonuses rejected with `400`).
3. Salary-run revenue load scoped to `[period.start, period.end]` (efficiency; no behavior change — the engine only looks up in-period location-days).
4. `GET /api/salary-runs/:id` test now asserts the exact read-back line values (String→numeric→Number round-trip), not just the line count.
