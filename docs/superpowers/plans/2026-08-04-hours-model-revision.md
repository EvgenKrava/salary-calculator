# Hours-Based Model Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-full-shift pay model with the real one: shifts carry explicit start/end times, hourly pay uses actual hours, revenue share is prorated by each person's share of the hours worked at that location that day, locations have their own working hours, and an employee may work multiple shifts/locations per day.

**Architecture:** `@salary/core` changes first (types, engine, migration `0002`), then `@salary/api` follows (Drizzle schema, DTOs, shift routes, salary-run mapping). The engine gains a **two-pass structure**: pass 1 aggregates total approved hours per `(locationId, workDate)` across *all* employees; pass 2 computes each employee's pay, using that denominator to prorate revenue share. Time-of-day arithmetic lives in one small module (`src/time.ts`) so the engine stays readable and the hours rule is tested in isolation.

**Tech Stack:** TypeScript (strict, ESM), Vitest, PGlite, Drizzle ORM, Hono, Zod — all already present.

## Global Constraints

- **Node** `>=20`, **pnpm**. TypeScript strict, ESM, extensionless relative imports.
- **This revision supersedes prior rules.** The old rules — "fixed full shift per day, length per location" and "each employee gets their own full % of the full daily revenue independent of hours" — are **wrong** and their tests must be **replaced**, not preserved. Reference: `docs/superpowers/specs/2026-08-03-salary-calculator-design.md` §3 (revised).
- **New formula** (spec §3):
  - `hours(shift) = endsAt − startsAt`, in hours.
  - `hourlyPay = Σ level.ratePerHour × hours(shift)`.
  - `revenueShare = Σ revenuePercent × dailyRevenue(loc, date) × hours(shift) / totalHours(loc, date)`, where `totalHours` sums hours over **all** approved shifts at that location-day (all employees).
  - `total = hourlyPay + revenueShare + bonus`, each component rounded independently via `round2`.
- **Times are `'HH:MM'` 24-hour strings** (e.g. `'08:00'`, `'17:30'`). A shift ending at or before its start is invalid (no overnight shifts in scope) → the engine throws, the API returns `400`.
- **Locations have `opensAt`/`closesAt`** (`'HH:MM'`), replacing `standardShiftHours`. They are the default shift window when a source supplies no times.
- **Shift uniqueness** relaxes from `(employee_id, work_date)` to `(employee_id, work_date, location_id, starts_at)`. An employee may work several shifts and several locations in one day.
- **Blocker rule unchanged:** a worked `(location, date)` with no approved revenue → recorded gap, `blocked = true`.
- **Migration is additive-then-tightening SQL** in a new `0002_hours_model.sql`; `0001_init.sql` is **not** edited (it is already applied conceptually and is the tested baseline for existing rows).

---

### Task 1: Time helpers in `@salary/core`

**Files:**
- Create: `packages/core/src/time.ts`
- Test: `packages/core/test/time.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseTime(value: string): number` — `'HH:MM'` → minutes since midnight; throws on malformed input.
  - `hoursBetween(startsAt: string, endsAt: string): number` — decimal hours; throws if `endsAt <= startsAt`.
  - `isTimeString(value: string): boolean` — cheap validity check for callers that prefer a boolean.

- [ ] **Step 1: Write the failing time test**

`packages/core/test/time.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseTime, hoursBetween, isTimeString } from '../src/time';

describe('parseTime', () => {
  it('converts HH:MM to minutes since midnight', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('08:30')).toBe(510);
    expect(parseTime('23:59')).toBe(1439);
  });

  it('throws on malformed input', () => {
    expect(() => parseTime('8:30')).toThrow();
    expect(() => parseTime('24:00')).toThrow();
    expect(() => parseTime('08:60')).toThrow();
    expect(() => parseTime('not a time')).toThrow();
  });
});

describe('hoursBetween', () => {
  it('returns decimal hours', () => {
    expect(hoursBetween('08:00', '16:00')).toBe(8);
    expect(hoursBetween('08:00', '12:30')).toBe(4.5);
    expect(hoursBetween('09:15', '09:45')).toBe(0.5);
  });

  it('throws when the end is not after the start', () => {
    expect(() => hoursBetween('08:00', '08:00')).toThrow();
    expect(() => hoursBetween('16:00', '08:00')).toThrow();
  });
});

describe('isTimeString', () => {
  it('accepts valid and rejects invalid times', () => {
    expect(isTimeString('07:05')).toBe(true);
    expect(isTimeString('7:05')).toBe(false);
    expect(isTimeString('25:00')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/core test time`
Expected: FAIL — cannot resolve `../src/time`.

- [ ] **Step 3: Implement the time helpers**

`packages/core/src/time.ts`:
```ts
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True if `value` is a valid 'HH:MM' 24-hour time string. */
export function isTimeString(value: string): boolean {
  return TIME_RE.test(value);
}

/** Convert 'HH:MM' to minutes since midnight. Throws if malformed. */
export function parseTime(value: string): number {
  const match = TIME_RE.exec(value);
  if (!match) throw new Error(`Invalid time '${value}': expected 'HH:MM' (24-hour)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Decimal hours between two 'HH:MM' times on the same day.
 * Overnight shifts are out of scope, so the end must be after the start.
 */
export function hoursBetween(startsAt: string, endsAt: string): number {
  const start = parseTime(startsAt);
  const end = parseTime(endsAt);
  if (end <= start) {
    throw new Error(`Invalid shift window ${startsAt}-${endsAt}: end must be after start`);
  }
  return (end - start) / 60;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @salary/core test time`
Expected: PASS — all time tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/time.ts packages/core/test/time.test.ts
git commit -m "Add time helpers for hours-based shifts"
```

---

### Task 2: Rewrite the calculation engine for hours + proration

**Files:**
- Modify: `packages/core/src/types.ts` (Location, Shift)
- Modify: `packages/core/src/calculateSalaries.ts` (two-pass rewrite)
- Modify: `packages/core/src/index.ts` (export time helpers)
- Modify: `packages/core/test/calculateSalaries.test.ts` (**replace** the superseded rules' tests)

**Interfaces:**
- Consumes: `hoursBetween` (Task 1), `round2`, `isWithinPeriod`.
- Produces: updated `Location` (`opensAt`/`closesAt`, no `standardShiftHours`), updated `Shift` (`startsAt`/`endsAt`, `source` adds `'imported'`), and the rewritten `calculateSalaries` with the same `CalcResult` shape.

- [ ] **Step 1: Update the domain types**

In `packages/core/src/types.ts`, replace the `Location` interface:
```ts
export interface Location {
  id: string;
  name: string;
  /** Location working hours, 'HH:MM'. Used as the default shift window. */
  opensAt: string;
  closesAt: string;
}
```
Replace the `Shift` interface:
```ts
export interface Shift {
  id: string;
  employeeId: string;
  locationId: string;
  workDate: string; // 'YYYY-MM-DD'
  /** Shift window, 'HH:MM'. Hours worked is the difference. */
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  source: ShiftSource;
}
```
Extend the source union (spreadsheet import is a third path):
```ts
export type ShiftSource = 'native' | 'extracted' | 'imported';
```

- [ ] **Step 2: Replace the superseded engine tests**

In `packages/core/test/calculateSalaries.test.ts`, update `baseInput()` so locations carry hours and shifts carry times:
```ts
function baseInput(): CalcInput {
  return {
    levels: [{ id: 'lvl1', name: 'Junior', ratePerHour: 20 }],
    locations: [{ id: 'locA', name: 'A', opensAt: '08:00', closesAt: '16:00' }],
    employees: [
      { id: 'e1', name: 'Alice', levelId: 'lvl1', revenuePercent: 0.05, cognitoSub: null, active: true },
    ],
    shifts: [
      {
        id: 's1', employeeId: 'e1', locationId: 'locA', workDate: '2026-08-02',
        startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native',
      },
    ],
    dailyRevenue: [
      { locationId: 'locA', revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
    ],
    bonuses: {},
  };
}
```
**Delete** the two tests that encode the superseded rules — `'gives each employee their own full % of the same day revenue'` and `'counts revenue share once per location-day despite multiple same-day shifts'` — and the `'records a single gap for a missing-revenue day even with multiple same-day shifts'` test's reliance on a duplicate shift row (keep a gap test, but with one shift). Replace them with the new rules:
```ts
  it('pays hourly by actual hours worked', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // 4 hours instead of 8
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(80); // 20 x 4
  });

  it('gives the whole day revenue share to the only person who worked it', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines[0].revenueShare).toBe(50); // 0.05 x 1000 x (8/8)
  });

  it('prorates revenue share by each person share of the hours', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice: 4h
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', revenuePercent: 0.1, cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '12:00', endsAt: '16:00', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    const bob = result.lines.find((l) => l.employeeId === 'e2')!;
    // total hours that location-day = 8; each worked 4 => half of their own percent
    expect(alice.revenueShare).toBe(25); // 0.05 x 1000 x 4/8
    expect(bob.revenueShare).toBe(50); // 0.10 x 1000 x 4/8
    expect(alice.hourlyPay).toBe(80);
    expect(bob.hourlyPay).toBe(80);
  });

  it('sums multiple shifts for one employee in a day across locations', () => {
    const input = baseInput();
    input.locations.push({ id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' });
    input.shifts[0].endsAt = '12:00'; // 4h at A
    input.shifts.push({
      id: 's3', employeeId: 'e1', locationId: 'locB', workDate: '2026-08-02',
      startsAt: '13:00', endsAt: '17:00', status: 'approved', source: 'native',
    });
    input.dailyRevenue.push({ locationId: 'locB', revenueDate: '2026-08-02', amount: 500, status: 'approved' });
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(160); // 20 x (4 + 4)
    // sole worker at each location that day => full percent of each
    expect(result.lines[0].revenueShare).toBe(75); // 0.05 x 1000 + 0.05 x 500
  });

  it('excludes non-approved shifts from the proration denominator', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice 4h approved
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', revenuePercent: 0.1, cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '12:00', endsAt: '16:00', status: 'requested', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    // Bob's requested shift does not count: Alice is the only approved worker => full percent
    expect(alice.revenueShare).toBe(50);
  });

  it('throws on a shift whose end is not after its start', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '08:00';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/end must be after start/);
  });
```
Also update the remaining tests that construct shifts (the outside-period, not-approved, bonus, rounding, unknown-level/location, and gap tests) so every shift literal includes `startsAt`/`endsAt`, and every location literal uses `opensAt`/`closesAt`. The rounding test's expectations change with proration — assert the invariant rather than a magic number:
```ts
  it('rounds each component and keeps the total consistent', () => {
    const input = baseInput();
    input.employees[0].revenuePercent = 0.0333;
    input.dailyRevenue[0].amount = 1000.126;
    const result = calculateSalaries(input, PERIOD);
    const line = result.lines[0];
    expect(line.revenueShare).toBe(33.3); // sole worker: 0.0333 x 1000.126 rounded
    expect(line.total).toBe(Math.round((line.hourlyPay + line.revenueShare + line.bonus) * 100) / 100);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @salary/core test calculateSalaries`
Expected: FAIL — the engine still multiplies by `standardShiftHours` (now absent from `Location`) and does not prorate; TypeScript/assertion errors are both expected at this point.

- [ ] **Step 4: Rewrite the engine (two passes)**

Replace the body of `packages/core/src/calculateSalaries.ts`:
```ts
import type {
  CalcInput,
  CalcResult,
  EmployeeBreakdown,
  PayPeriod,
  RevenueGap,
  Shift,
} from './types';
import { isWithinPeriod } from './payPeriod';
import { hoursBetween } from './time';
import { round2 } from './money';

function dayKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

/**
 * Compute per-employee pay for a pay period.
 *
 * Hourly pay = level rate x actual hours worked (shift end - start), summed over the
 * employee's approved shifts in the period. Revenue share = the employee's revenue
 * fraction x the location-day's approved revenue, prorated by that employee's share of
 * the total hours worked at that location on that day (days are commonly split between
 * people). A worked location-day with no approved revenue is recorded as a gap and marks
 * the result `blocked`.
 */
export function calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult {
  const levelById = new Map(input.levels.map((l) => [l.id, l]));
  const locationById = new Map(input.locations.map((loc) => [loc.id, loc]));

  const revenueByDay = new Map<string, number>();
  for (const r of input.dailyRevenue) {
    if (r.status === 'approved') {
      revenueByDay.set(dayKey(r.locationId, r.revenueDate), r.amount);
    }
  }

  // Only approved, in-period shifts participate — in pay, in gaps, and in the
  // proration denominator.
  const relevant: Shift[] = input.shifts.filter(
    (s) => s.status === 'approved' && isWithinPeriod(s.workDate, period),
  );

  // Pass 1: total hours worked per location-day, across ALL employees. This is the
  // denominator that makes each person's revenue share proportional to their time.
  const totalHoursByDay = new Map<string, number>();
  const hoursByShiftId = new Map<string, number>();
  for (const shift of relevant) {
    if (!locationById.has(shift.locationId)) {
      throw new Error(`Shift ${shift.id} references unknown location ${shift.locationId}`);
    }
    const hours = hoursBetween(shift.startsAt, shift.endsAt);
    hoursByShiftId.set(shift.id, hours);
    const key = dayKey(shift.locationId, shift.workDate);
    totalHoursByDay.set(key, (totalHoursByDay.get(key) ?? 0) + hours);
  }

  const shiftsByEmployee = new Map<string, Shift[]>();
  for (const shift of relevant) {
    const list = shiftsByEmployee.get(shift.employeeId) ?? [];
    list.push(shift);
    shiftsByEmployee.set(shift.employeeId, list);
  }

  const lines: EmployeeBreakdown[] = [];
  const gaps: RevenueGap[] = [];

  // Pass 2: per-employee pay, using the location-day totals from pass 1.
  for (const employee of input.employees) {
    if (!employee.active) continue;

    const level = levelById.get(employee.levelId);
    if (!level) {
      throw new Error(`Employee ${employee.id} references unknown level ${employee.levelId}`);
    }

    const empShifts = shiftsByEmployee.get(employee.id) ?? [];
    let hourlyPay = 0;
    let revenueShare = 0;
    // One gap per employee per location-day, even if they worked it in several shifts.
    const gapDays = new Set<string>();

    for (const shift of empShifts) {
      const hours = hoursByShiftId.get(shift.id)!;
      hourlyPay += level.ratePerHour * hours;

      const key = dayKey(shift.locationId, shift.workDate);
      const revenue = revenueByDay.get(key);
      if (revenue === undefined) {
        if (!gapDays.has(key)) {
          gapDays.add(key);
          gaps.push({ employeeId: employee.id, locationId: shift.locationId, date: shift.workDate });
        }
        continue;
      }
      const totalHours = totalHoursByDay.get(key)!;
      revenueShare += employee.revenuePercent * revenue * (hours / totalHours);
    }

    const roundedHourly = round2(hourlyPay);
    const roundedShare = round2(revenueShare);
    const roundedBonus = round2(input.bonuses[employee.id] ?? 0);
    lines.push({
      employeeId: employee.id,
      hourlyPay: roundedHourly,
      revenueShare: roundedShare,
      bonus: roundedBonus,
      total: round2(roundedHourly + roundedShare + roundedBonus),
    });
  }

  return { period, lines, gaps, blocked: gaps.length > 0 };
}
```

- [ ] **Step 5: Export the time helpers**

In `packages/core/src/index.ts`, add:
```ts
export { parseTime, hoursBetween, isTimeString } from './time';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @salary/core test`
Then: `pnpm --filter @salary/core typecheck`
Expected: PASS — all core tests green (money, payPeriod, time, calculateSalaries, schema) and typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/calculateSalaries.ts packages/core/src/index.ts packages/core/test/calculateSalaries.test.ts
git commit -m "Rewrite calculation engine for actual hours and hour-prorated revenue share"
```

---

### Task 3: Schema migration `0002_hours_model.sql`

**Files:**
- Create: `packages/core/db/migrations/0002_hours_model.sql`
- Modify: `packages/core/src/migrations.ts` (export the second migration + an ordered list)
- Modify: `packages/core/test/schema.test.ts` (apply both migrations; assert the new shape)

**Interfaces:**
- Consumes: `0001_init.sql` (unchanged).
- Produces: `MIGRATIONS: string[]` (ordered) and `INIT_SQL` (kept for compatibility) from `@salary/core/migrations` — consumed by the API's `createTestDb` (Task 4).

- [ ] **Step 1: Write the migration**

`packages/core/db/migrations/0002_hours_model.sql`:
```sql
-- Hours-based model: shifts carry explicit windows, locations carry working hours,
-- and an employee may work several shifts/locations per day.

-- Locations: working hours replace the single standard shift length.
ALTER TABLE locations ADD COLUMN opens_at TIME NOT NULL DEFAULT '08:00';
ALTER TABLE locations ADD COLUMN closes_at TIME NOT NULL DEFAULT '20:00';
ALTER TABLE locations ADD CONSTRAINT locations_hours_order CHECK (closes_at > opens_at);
ALTER TABLE locations DROP COLUMN standard_shift_hours;

-- Shifts: explicit window. Existing rows get the location's hours as their window.
ALTER TABLE shifts ADD COLUMN starts_at TIME;
ALTER TABLE shifts ADD COLUMN ends_at TIME;

UPDATE shifts s
SET starts_at = l.opens_at,
    ends_at   = l.closes_at
FROM locations l
WHERE l.id = s.location_id
  AND (s.starts_at IS NULL OR s.ends_at IS NULL);

ALTER TABLE shifts ALTER COLUMN starts_at SET NOT NULL;
ALTER TABLE shifts ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE shifts ADD CONSTRAINT shifts_window_order CHECK (ends_at > starts_at);

-- A day may be split between people and across locations: relax the uniqueness.
ALTER TABLE shifts DROP CONSTRAINT shifts_employee_id_work_date_key;
ALTER TABLE shifts ADD CONSTRAINT shifts_employee_day_location_start_key
  UNIQUE (employee_id, work_date, location_id, starts_at);

-- Spreadsheet import is a third schedule source.
ALTER TYPE shift_source ADD VALUE IF NOT EXISTS 'imported';
```

Note on the dropped constraint name: `0001_init.sql` declares `UNIQUE (employee_id, work_date)` inline, so Postgres names it `shifts_employee_id_work_date_key`. If applying this migration errors with "constraint does not exist", run `\d shifts` (or query `pg_constraint`) to get the actual name and correct the `DROP CONSTRAINT` line — do not skip the drop, since the old constraint would reject legitimate split days.

- [ ] **Step 2: Update the migrations module**

Replace `packages/core/src/migrations.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(here, '../db/migrations', name), 'utf8');
}

/** The initial schema migration. Node-only. */
export const INIT_SQL = read('0001_init.sql');

/** The hours-based model migration. Node-only. */
export const HOURS_MODEL_SQL = read('0002_hours_model.sql');

/** All migrations in apply order. Node-only. */
export const MIGRATIONS: string[] = [INIT_SQL, HOURS_MODEL_SQL];
```

- [ ] **Step 3: Update the schema test to apply both migrations**

In `packages/core/test/schema.test.ts`, replace the single-migration read with the ordered list and apply each in `beforeAll`:
```ts
import { MIGRATIONS } from '../src/migrations';

// ...inside beforeAll, replacing the single `await db.exec(migration)`:
    db = new PGlite();
    for (const sql of MIGRATIONS) {
      await db.exec(sql);
    }
```
Update the seed inserts to the new location columns (`opens_at`, `closes_at` instead of `standard_shift_hours`) and give shift inserts a window. Then replace the old employee-day uniqueness test with the new composite behaviour:
```ts
  it('allows an employee two shifts in a day at different times', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-02', '08:00', '12:00');`,
    );
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-02', '13:00', '17:00');`,
    );
    const res = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM shifts WHERE work_date = '2026-09-02';`,
    );
    expect(res.rows[0].count).toBe('2');
  });

  it('still rejects an exact duplicate shift window', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-03', '08:00', '12:00');`,
    );
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-03', '08:00', '12:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a shift whose end is not after its start', async () => {
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-04', '12:00', '08:00');`,
      ),
    ).rejects.toThrow();
  });
```

- [ ] **Step 4: Run the schema test**

Run: `pnpm --filter @salary/core test schema`
Expected: PASS. If `ALTER TYPE ... ADD VALUE` fails inside PGlite's implicit transaction, move that statement to the **top** of `0002_hours_model.sql` (it must not share a transaction with statements that use the new value) — nothing in this migration uses `'imported'`, so ordering is the only fix needed. If the `DROP CONSTRAINT` name is wrong, correct it per the Step-1 note.

- [ ] **Step 5: Full core suite, typecheck, commit**

Run: `pnpm --filter @salary/core test && pnpm --filter @salary/core typecheck`
Expected: all green.
```bash
git add packages/core/db/migrations/0002_hours_model.sql packages/core/src/migrations.ts packages/core/test/schema.test.ts
git commit -m "Add hours-model migration relaxing shift uniqueness and adding location hours"
```

---

### Task 4: API schema, DTOs, and shift routes

**Files:**
- Modify: `packages/api/src/schema.ts` (locations hours, shift window, `imported` source, composite unique)
- Modify: `packages/api/src/db/testDb.ts` (apply all migrations)
- Modify: `packages/api/src/routes/locations.ts` (hours instead of standardShiftHours)
- Modify: `packages/api/src/routes/shifts.ts` (times on request/assign, window validation)
- Modify: `packages/api/test/locations.test.ts`, `packages/api/test/shifts-employee.test.ts`, `packages/api/test/shifts-manager.test.ts`
- Modify: any other API test that seeds `locations`/`shifts` (`revenue.test.ts`, `salary-runs.test.ts`, `salary-me.test.ts`, `schema.test.ts`)

**Interfaces:**
- Consumes: `MIGRATIONS` (Task 3), the revised core types (Task 2).
- Produces: location DTO `{ id, name, opensAt, closesAt }`; shift DTO gains `startsAt`/`endsAt`.

- [ ] **Step 1: Update the Drizzle schema**

In `packages/api/src/schema.ts`:
- Add `'imported'` to the shift source enum: `export const shiftSource = pgEnum('shift_source', ['native', 'extracted', 'imported']);`
- Replace the `locations` numeric column with times (import `time` from `drizzle-orm/pg-core`):
```ts
export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(),
});
```
- Add the window columns to `shifts` and change its unique constraint:
```ts
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
```
```ts
  (t) => [unique().on(t.employeeId, t.workDate, t.locationId, t.startsAt)],
```

- [ ] **Step 2: Apply all migrations in the API test DB**

In `packages/api/src/db/testDb.ts`, replace the `INIT_SQL` import and single `exec`:
```ts
import { MIGRATIONS } from '@salary/core/migrations';
```
```ts
  const client = new PGlite();
  for (const sql of MIGRATIONS) {
    await client.exec(sql);
  }
```

- [ ] **Step 3: Update the locations routes**

In `packages/api/src/routes/locations.ts`, replace the schemas, DTO, and insert/patch mapping. Times are `'HH:MM'` strings validated by regex, and `closesAt` must be after `opensAt`:
```ts
const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');

const createSchema = z
  .object({
    name: z.string().min(1),
    opensAt: timeString,
    closesAt: timeString,
  })
  .refine((v) => v.closesAt > v.opensAt, { message: 'closesAt must be after opensAt' });

const updateSchema = z
  .object({ name: z.string().min(1), opensAt: timeString, closesAt: timeString })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
```
```ts
function toDto(row: LocationRow) {
  return { id: row.id, name: row.name, opensAt: row.opensAt, closesAt: row.closesAt };
}
```
In `POST`, insert `{ name: body.name, opensAt: body.opensAt, closesAt: body.closesAt }`. In `PATCH`, set `patch.opensAt`/`patch.closesAt` when defined (drop the `standardShiftHours` branch); after building the patch, re-read the row's effective window and reject an inverted one:
```ts
    const current = await db.select().from(locations).where(eq(locations.id, id));
    const existing = getOr404(current, 'location not found');
    const opensAt = patch.opensAt ?? existing.opensAt;
    const closesAt = patch.closesAt ?? existing.closesAt;
    if (closesAt <= opensAt) throw new HTTPException(400, { message: 'closesAt must be after opensAt' });
```
Note: Postgres `TIME` values come back from Drizzle as `'HH:MM:SS'` strings. Compare and return them consistently — normalize the DTO to `HH:MM` with `row.opensAt.slice(0, 5)` so the API contract matches the documented `'HH:MM'` format, and use the same slice before any comparison.

- [ ] **Step 4: Update the shift routes**

In `packages/api/src/routes/shifts.ts`:
- Add the time schema next to `dateString`:
```ts
const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');
```
- Extend `requestSchema` and `assignSchema` with optional times (defaulting to the location's hours when omitted):
```ts
const requestSchema = z.object({
  locationId: z.string().uuid(),
  workDate: dateString,
  startsAt: timeString.optional(),
  endsAt: timeString.optional(),
});
```
```ts
const assignSchema = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
  workDate: dateString,
  startsAt: timeString.optional(),
  endsAt: timeString.optional(),
  status: z.enum(['requested', 'approved']).default('approved'),
});
```
- Replace `requireLocation` so it returns the row (its hours are the default window) and add a window resolver:
```ts
  async function loadLocation(locationId: string) {
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
    return rows[0];
  }

  async function resolveWindow(
    locationId: string,
    startsAt?: string,
    endsAt?: string,
  ): Promise<{ startsAt: string; endsAt: string }> {
    const location = await loadLocation(locationId);
    const start = startsAt ?? location.opensAt.slice(0, 5);
    const end = endsAt ?? location.closesAt.slice(0, 5);
    if (end <= start) throw new HTTPException(400, { message: 'endsAt must be after startsAt' });
    return { startsAt: start, endsAt: end };
  }
```
- In `POST /requests` and `POST /`, call `resolveWindow(...)` (it replaces the old `requireLocation` call) and include `startsAt`/`endsAt` in the insert values.
- Extend `toDto` with `startsAt: row.startsAt.slice(0, 5)` and `endsAt: row.endsAt.slice(0, 5)`.

- [ ] **Step 5: Update the affected API tests**

Across the API test files, replace every `locations` seed/creation that used `standardShiftHours: '8.00'` (or `standardShiftHours: 8`) with `opensAt: '08:00', closesAt: '16:00'`, and give every direct `shifts` insert `startsAt: '08:00', endsAt: '16:00'`. In `locations.test.ts`, replace the shift-hours assertions with hours ones and the zero/negative-hours 400 test with an inverted-window 400 test:
```ts
  it('rejects closesAt not after opensAt (400)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Bad', opensAt: '18:00', closesAt: '09:00' }),
    });
    expect(res.status).toBe(400);
  });
```
In `shifts-employee.test.ts` / `shifts-manager.test.ts`, add coverage for the new behaviour:
```ts
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
```
And in the manager suite, replace the "409s an assign that duplicates an employee-day" test — a same-day second shift is now legal at a different time, and only an identical window conflicts:
```ts
  it('allows a second same-day shift at a different time', async () => {
    const { app, loc, alice } = await seed();
    await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', startsAt: '08:00', endsAt: '12:00' });
    const second = await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', startsAt: '12:00', endsAt: '16:00' });
    expect(second.status).toBe(201);
  });

  it('409s an assign duplicating the same window', async () => {
    const { app, loc, alice } = await seed();
    const body = { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-11', startsAt: '08:00', endsAt: '12:00' };
    await assign(app, body);
    expect((await assign(app, body)).status).toBe(409);
  });
```

- [ ] **Step 6: Run the API suite**

Run: `pnpm --filter @salary/api test`
Then: `pnpm --filter @salary/api typecheck`
Expected: PASS — all API tests green. Every failure here is a seed/DTO shape that still uses the old model; fix the test data, not the new rules.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src packages/api/test
git commit -m "Update API for hours-based shifts and location working hours"
```

---

### Task 5: Salary-run mapping + end-to-end proration test

**Files:**
- Modify: `packages/api/src/routes/salaryRuns.ts` (map the new fields into `CalcInput`)
- Modify: `packages/api/test/salary-runs.test.ts` (update expectations; add a split-day case)

**Interfaces:**
- Consumes: the revised `CalcInput` (Task 2), the updated schema (Task 4).
- Produces: no signature change — the run response shape is unchanged.

- [ ] **Step 1: Update the CalcInput mapping**

In `packages/api/src/routes/salaryRuns.ts`, the `locations` and `shifts` mappings must carry the new fields (times normalized to `'HH:MM'`):
```ts
      locations: locs.map((l) => ({
        id: l.id,
        name: l.name,
        opensAt: l.opensAt.slice(0, 5),
        closesAt: l.closesAt.slice(0, 5),
      })),
      shifts: shfts.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        locationId: s.locationId,
        workDate: s.workDate,
        startsAt: s.startsAt.slice(0, 5),
        endsAt: s.endsAt.slice(0, 5),
        status: s.status,
        source: s.source,
      })),
```

- [ ] **Step 2: Update and extend the salary-run tests**

In `packages/api/test/salary-runs.test.ts`, the seed's location becomes `opensAt: '08:00', closesAt: '16:00'` and each `shifts` insert gains `startsAt: '08:00', endsAt: '16:00'`. The happy-path expectation is unchanged (a sole worker on a full 8-hour day still earns `20 × 8 = 160` hourly and the full `0.05 × 1000 = 50` share, `+25` bonus = `235`) — confirm this still holds. Add the split-day case that proves proration end-to-end:
```ts
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
    const run = await res.json();
    const aliceLine = run.lines.find((l: { employeeId: string }) => l.employeeId === alice.id);
    const bobLine = run.lines.find((l: { employeeId: string }) => l.employeeId === bob.id);
    // each worked 4 of the day's 8 hours => half of their own 5%
    expect(aliceLine).toMatchObject({ hourlyPay: 80, revenueShare: 25 });
    expect(bobLine).toMatchObject({ hourlyPay: 80, revenueShare: 25 });
  });
```
This test needs `levels`, `employees`, `shifts`, `dailyRevenue` imported from `../src/schema` and the seed to return `db` — extend the existing imports/`seed()` return if they don't already provide them.

- [ ] **Step 3: Run the full workspace suite and typecheck**

Run: `pnpm -r test`
Then: `pnpm -r typecheck`
Expected: PASS — both packages fully green (core + api), no stale references to `standardShiftHours` anywhere.

- [ ] **Step 4: Confirm nothing still references the old model**

Run: `grep -rn "standardShiftHours\|standard_shift_hours" packages/ --include=*.ts --include=*.sql | grep -v 0001_init.sql`
Expected: no output (the only permitted mention is the historical `0001_init.sql`, which is intentionally frozen).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/salaryRuns.ts packages/api/test/salary-runs.test.ts
git commit -m "Map hours into the salary run and verify proration end to end"
```

---

## Self-Review

**Spec coverage (revised §3, §4, §5):**
- Hours-based hourly pay → Task 1 (helpers) + Task 2 (engine) + Task 5 (end-to-end).
- Hour-prorated revenue share, denominator = all approved hours at that location-day → Task 2 (two-pass engine, dedicated tests) + Task 5 (split-day E2E).
- Location working hours (`opensAt`/`closesAt`) replacing `standardShiftHours` → Task 2 (type), Task 3 (migration), Task 4 (schema, routes, default window).
- Multiple shifts/locations per employee per day → Task 3 (relaxed composite unique) + Task 2 (summing test) + Task 4 (manager same-day test).
- `imported` shift source for the coming xlsx path → Task 2 (union) + Task 3 (`ALTER TYPE`) + Task 4 (pg enum).
- Blocker rule preserved → Task 2 (gap dedup per employee-location-day).

**Superseded tests explicitly replaced (not silently kept):** the "full % per person independent of hours" test and the "revenue share once per location-day despite multiple same-day shifts" test in `calculateSalaries.test.ts`; the employee-day uniqueness tests in both `schema.test.ts` files; the location zero-hours 400 test; the manager duplicate-employee-day 409 test. Each is named in the task that replaces it.

**Placeholder scan:** No TBD/TODO. The two contingencies (the `DROP CONSTRAINT` name, and `ALTER TYPE ADD VALUE` transaction placement) are concrete, test-arbitrated instructions with the exact remedy stated.

**Type consistency:** `Location.opensAt/closesAt` and `Shift.startsAt/endsAt` are `'HH:MM'` strings everywhere in core; the API normalizes Postgres `TIME` (`'HH:MM:SS'`) with `.slice(0, 5)` at every boundary (location DTO, shift DTO, `CalcInput` mapping) so core never sees seconds. `hoursBetween` is the single place shift duration is computed, used by the engine and validated by the API's window checks.
