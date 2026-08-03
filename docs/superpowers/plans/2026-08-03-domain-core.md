# Domain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure salary-calculation engine and the Postgres schema for the Salary Calculator, fully unit-tested in isolation with no cloud dependencies.

**Architecture:** A pnpm workspace whose first package, `@salary/core`, holds the domain types, money/date helpers, the `calculateSalaries` engine (a pure function over plain data), and the database DDL. The engine is deterministic and has no I/O; later plans (API, extraction, frontend) consume this package. The schema is validated in-process with PGlite (embedded Postgres) so no Docker or live database is required.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, Vitest, `@electric-sql/pglite` for the schema test. No runtime dependencies in the core package.

## Global Constraints

- **Node** `>=20`; package manager **pnpm**.
- **TypeScript** strict mode, ESM (`"type": "module"`), `moduleResolution: "bundler"` — write **extensionless** relative imports (`./money`, not `./money.js`).
- The `@salary/core` package is consumed as **raw TypeScript** (its `exports` point at `src/index.ts`); consumers bundle it. No build step in this plan.
- **`revenuePercent` is stored as a fraction in `[0, 1]`** (e.g. `0.05` = 5%), never as a whole-number percentage.
- **Money is rounded to 2 decimals**, half away from zero, and **exact at the half-cent boundary** (`1.005` → `1.01`, `35.855` → `35.86`) — a naive `Math.round(x*100)/100` is wrong here and must not be used. Each breakdown component (`hourlyPay`, `revenueShare`, `bonus`) is rounded independently and `total` equals the sum of the three rounded components, so the displayed breakdown always adds up.
- **Dates are `'YYYY-MM-DD'` strings** compared lexicographically; pay periods are the **1st–15th** and **16th–end of month**.
- **The calculation reads only `status = 'approved'` shifts and `status = 'approved'` revenue.** If any worked `(location, date)` has no approved revenue, that day is recorded as a gap and the result is `blocked`.

---

### Task 1: Workspace scaffold + money helper

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (repo root)
- Create: `.nvmrc`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/money.ts`
- Test: `packages/core/test/money.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `round2(value: number): number` from `@salary/core` internal module `./money`.

- [ ] **Step 1: Create the workspace root files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`package.json` (root):
```json
{
  "name": "salary-calculator",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`.nvmrc`:
```
20
```

- [ ] **Step 2: Create the core package config**

`packages/core/package.json`:
```json
{
  "name": "@salary/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.12",
    "@types/node": "^22.7.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.2"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: pnpm creates `node_modules` and `pnpm-lock.yaml`, resolving `@salary/core`'s dev dependencies with no errors.

- [ ] **Step 4: Write the failing money test**

`packages/core/test/money.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { round2 } from '../src/money';

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(10.126)).toBe(10.13);
    expect(round2(10.124)).toBe(10.12);
  });

  it('leaves clean values unchanged', () => {
    expect(round2(10)).toBe(10);
    expect(round2(2.5)).toBe(2.5);
  });

  it('fixes binary floating-point drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds half away from zero at the half-cent boundary', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(35.855)).toBe(35.86);
    expect(round2(2.345)).toBe(2.35);
    expect(round2(-1.005)).toBe(-1.01);
  });

  it('does not over-round values genuinely below the half cent', () => {
    expect(round2(35.854)).toBe(35.85);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @salary/core test`
Expected: FAIL — cannot resolve `../src/money` (module does not exist).

- [ ] **Step 6: Implement the money helper**

`packages/core/src/money.ts`:
```ts
/**
 * Round a monetary amount to 2 decimal places (cents), half away from zero.
 *
 * A naive `Math.round(value * 100) / 100` mis-rounds half-cent boundaries
 * (e.g. 1.005 -> 1.00) because values like 1.005 are stored slightly below
 * their decimal value in binary floating point. Correcting the scaled value
 * proportionally to its magnitude (`* (1 + Number.EPSILON)`) absorbs that
 * representation drift without over-rounding amounts genuinely below the
 * boundary, since the correction is far smaller than any real fractional gap.
 */
export function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 100;
  const rounded = Math.round(scaled * (1 + Number.EPSILON));
  return (sign * rounded) / 100;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @salary/core test`
Expected: PASS — 3 tests green.

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json .nvmrc packages/core pnpm-lock.yaml
git commit -m "Scaffold pnpm workspace and core money helper"
```

---

### Task 2: Pay-period helpers

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/payPeriod.ts`
- Test: `packages/core/test/payPeriod.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `interface PayPeriod { start: string; end: string }` (inclusive `'YYYY-MM-DD'`).
  - `payPeriodsForMonth(year: number, month: number): [PayPeriod, PayPeriod]` — `month` is 1–12.
  - `isWithinPeriod(date: string, period: PayPeriod): boolean`.

- [ ] **Step 1: Add the `PayPeriod` type**

`packages/core/src/types.ts`:
```ts
/** A pay period, inclusive of both boundary dates ('YYYY-MM-DD'). */
export interface PayPeriod {
  start: string;
  end: string;
}
```

- [ ] **Step 2: Write the failing pay-period test**

`packages/core/test/payPeriod.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { payPeriodsForMonth, isWithinPeriod } from '../src/payPeriod';

describe('payPeriodsForMonth', () => {
  it('splits a 31-day month into 1-15 and 16-31', () => {
    const [first, second] = payPeriodsForMonth(2026, 8);
    expect(first).toEqual({ start: '2026-08-01', end: '2026-08-15' });
    expect(second).toEqual({ start: '2026-08-16', end: '2026-08-31' });
  });

  it('handles February in a non-leap year', () => {
    const [, second] = payPeriodsForMonth(2026, 2);
    expect(second).toEqual({ start: '2026-02-16', end: '2026-02-28' });
  });

  it('handles February in a leap year', () => {
    const [, second] = payPeriodsForMonth(2024, 2);
    expect(second).toEqual({ start: '2024-02-16', end: '2024-02-29' });
  });
});

describe('isWithinPeriod', () => {
  const period = { start: '2026-08-01', end: '2026-08-15' };

  it('includes both boundaries', () => {
    expect(isWithinPeriod('2026-08-01', period)).toBe(true);
    expect(isWithinPeriod('2026-08-15', period)).toBe(true);
  });

  it('excludes dates outside the range', () => {
    expect(isWithinPeriod('2026-08-16', period)).toBe(false);
    expect(isWithinPeriod('2026-07-31', period)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @salary/core test payPeriod`
Expected: FAIL — cannot resolve `../src/payPeriod`.

- [ ] **Step 4: Implement the pay-period helpers**

`packages/core/src/payPeriod.ts`:
```ts
import type { PayPeriod } from './types';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The two pay periods for a calendar month: 1st–15th and 16th–end of month.
 * `month` is 1-based (1 = January).
 */
export function payPeriodsForMonth(year: number, month: number): [PayPeriod, PayPeriod] {
  const mm = pad(month);
  // Day 0 of the next month is the last day of this month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    { start: `${year}-${mm}-01`, end: `${year}-${mm}-15` },
    { start: `${year}-${mm}-16`, end: `${year}-${mm}-${pad(lastDay)}` },
  ];
}

/** True if `date` ('YYYY-MM-DD') falls within `period`, inclusive of boundaries. */
export function isWithinPeriod(date: string, period: PayPeriod): boolean {
  return date >= period.start && date <= period.end;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @salary/core test payPeriod`
Expected: PASS — all pay-period tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/payPeriod.ts packages/core/test/payPeriod.test.ts
git commit -m "Add pay-period helpers"
```

---

### Task 3: Salary calculation engine

**Files:**
- Modify: `packages/core/src/types.ts` (add domain types)
- Create: `packages/core/src/calculateSalaries.ts`
- Test: `packages/core/test/calculateSalaries.test.ts`

**Interfaces:**
- Consumes: `PayPeriod`, `isWithinPeriod` (Task 2); `round2` (Task 1).
- Produces:
  - Types `Level`, `Location`, `Employee`, `Shift`, `DailyRevenue`, `EmployeeBreakdown`, `RevenueGap`, `CalcInput`, `CalcResult` and the string-literal unions `ShiftStatus`, `ShiftSource`, `RevenueSource`, `RevenueStatus`.
  - `calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult`.

- [ ] **Step 1: Add the domain types**

Append to `packages/core/src/types.ts`:
```ts
export type ShiftStatus = 'requested' | 'approved' | 'rejected';
export type ShiftSource = 'native' | 'extracted';
export type RevenueSource = 'manual' | 'extracted';
export type RevenueStatus = 'pending' | 'needs_review' | 'approved' | 'rejected';

export interface Level {
  id: string;
  name: string;
  ratePerHour: number;
}

export interface Location {
  id: string;
  name: string;
  standardShiftHours: number;
}

export interface Employee {
  id: string;
  name: string;
  levelId: string;
  /** Fraction in [0, 1]; 0.05 = 5%. */
  revenuePercent: number;
  cognitoSub: string | null;
  active: boolean;
}

export interface Shift {
  id: string;
  employeeId: string;
  locationId: string;
  workDate: string; // 'YYYY-MM-DD'
  status: ShiftStatus;
  source: ShiftSource;
}

export interface DailyRevenue {
  locationId: string;
  revenueDate: string; // 'YYYY-MM-DD'
  amount: number;
  status: RevenueStatus;
}

export interface EmployeeBreakdown {
  employeeId: string;
  hourlyPay: number;
  revenueShare: number;
  bonus: number;
  total: number;
}

export interface RevenueGap {
  employeeId: string;
  locationId: string;
  date: string;
}

export interface CalcInput {
  employees: Employee[];
  levels: Level[];
  locations: Location[];
  shifts: Shift[];
  dailyRevenue: DailyRevenue[];
  /** employeeId -> personal bonus amount for this run. */
  bonuses: Record<string, number>;
}

export interface CalcResult {
  period: PayPeriod;
  lines: EmployeeBreakdown[];
  gaps: RevenueGap[];
  blocked: boolean;
}
```

- [ ] **Step 2: Write the failing calculation tests**

`packages/core/test/calculateSalaries.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { calculateSalaries } from '../src/calculateSalaries';
import type { CalcInput, PayPeriod } from '../src/types';

const PERIOD: PayPeriod = { start: '2026-08-01', end: '2026-08-15' };

function baseInput(): CalcInput {
  return {
    levels: [{ id: 'lvl1', name: 'Junior', ratePerHour: 20 }],
    locations: [{ id: 'locA', name: 'A', standardShiftHours: 8 }],
    employees: [
      { id: 'e1', name: 'Alice', levelId: 'lvl1', revenuePercent: 0.05, cognitoSub: null, active: true },
    ],
    shifts: [
      { id: 's1', employeeId: 'e1', locationId: 'locA', workDate: '2026-08-02', status: 'approved', source: 'native' },
    ],
    dailyRevenue: [
      { locationId: 'locA', revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
    ],
    bonuses: {},
  };
}

describe('calculateSalaries', () => {
  it('returns nothing for empty input', () => {
    const result = calculateSalaries(
      { levels: [], locations: [], employees: [], shifts: [], dailyRevenue: [], bonuses: {} },
      PERIOD,
    );
    expect(result.lines).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it('computes hourly pay and revenue share for one shift', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({
      employeeId: 'e1',
      hourlyPay: 160, // 20 * 8
      revenueShare: 50, // 0.05 * 1000
      bonus: 0,
      total: 210,
    });
    expect(result.blocked).toBe(false);
  });

  it('gives each employee their own full % of the same day revenue', () => {
    const input = baseInput();
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', revenuePercent: 0.1, cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    const bob = result.lines.find((l) => l.employeeId === 'e2')!;
    expect(alice.revenueShare).toBe(50); // 0.05 * 1000
    expect(bob.revenueShare).toBe(100); // 0.10 * 1000 — full amount, not split
  });

  it('records a gap and blocks when revenue is missing for a worked day', () => {
    const input = baseInput();
    input.dailyRevenue = [];
    const result = calculateSalaries(input, PERIOD);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
    expect(result.blocked).toBe(true);
    // hourly pay still computed; missing revenue contributes 0 to the share.
    expect(result.lines[0].hourlyPay).toBe(160);
    expect(result.lines[0].revenueShare).toBe(0);
  });

  it('treats non-approved revenue as missing', () => {
    const input = baseInput();
    input.dailyRevenue[0].status = 'needs_review';
    const result = calculateSalaries(input, PERIOD);
    expect(result.blocked).toBe(true);
    expect(result.lines[0].revenueShare).toBe(0);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
  });

  it('counts revenue share once per location-day despite multiple same-day shifts', () => {
    const input = baseInput();
    input.shifts.push({
      id: 's1b', employeeId: 'e1', locationId: 'locA', workDate: '2026-08-02', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].revenueShare).toBe(50); // full % of the day's revenue, not doubled
  });

  it('records a single gap for a missing-revenue day even with multiple same-day shifts', () => {
    const input = baseInput();
    input.dailyRevenue = [];
    input.shifts.push({
      id: 's1b', employeeId: 'e1', locationId: 'locA', workDate: '2026-08-02', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
  });

  it('throws when a shift references an unknown location', () => {
    const input = baseInput();
    input.shifts[0].locationId = 'missing';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/unknown location/);
  });

  it('throws when an employee references an unknown level', () => {
    const input = baseInput();
    input.employees[0].levelId = 'missing';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/unknown level/);
  });

  it('skips inactive employees', () => {
    const input = baseInput();
    input.employees[0].active = false;
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines).toEqual([]);
  });

  it('ignores shifts outside the period', () => {
    const input = baseInput();
    input.shifts[0].workDate = '2026-08-20';
    input.dailyRevenue[0].revenueDate = '2026-08-20';
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(0);
    expect(result.lines[0].revenueShare).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it('ignores shifts that are not approved', () => {
    const input = baseInput();
    input.shifts[0].status = 'requested';
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it('adds the personal bonus into the total', () => {
    const input = baseInput();
    input.bonuses = { e1: 75.5 };
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].bonus).toBe(75.5);
    expect(result.lines[0].total).toBe(285.5); // 160 + 50 + 75.5
  });

  it('rounds each component and keeps the total consistent', () => {
    const input = baseInput();
    input.employees[0].revenuePercent = 0.0333; // 0.0333 * 1000 = 33.3
    input.dailyRevenue[0].amount = 1000.126;    // share = 0.0333 * 1000.126 = 33.30419...
    const result = calculateSalaries(input, PERIOD);
    const line = result.lines[0];
    expect(line.revenueShare).toBe(33.3);
    expect(line.total).toBe(Math.round((line.hourlyPay + line.revenueShare + line.bonus) * 100) / 100);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @salary/core test calculateSalaries`
Expected: FAIL — cannot resolve `../src/calculateSalaries`.

- [ ] **Step 4: Implement the calculation engine**

`packages/core/src/calculateSalaries.ts`:
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
import { round2 } from './money';

function revenueKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

/**
 * Compute per-employee pay for a pay period.
 *
 * Hourly pay = level rate x the worked location's standard shift hours, per approved
 * shift in the period. Revenue share = the employee's revenue fraction x the approved
 * daily revenue of each location they worked, on each day they worked it (full amount
 * per employee, never split). A worked day with no approved revenue is recorded as a
 * gap and marks the result `blocked`.
 */
export function calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult {
  const levelById = new Map(input.levels.map((l) => [l.id, l]));
  const locationById = new Map(input.locations.map((loc) => [loc.id, loc]));

  const revenueByKey = new Map<string, number>();
  for (const r of input.dailyRevenue) {
    if (r.status === 'approved') {
      revenueByKey.set(revenueKey(r.locationId, r.revenueDate), r.amount);
    }
  }

  const shiftsByEmployee = new Map<string, Shift[]>();
  for (const s of input.shifts) {
    if (s.status !== 'approved' || !isWithinPeriod(s.workDate, period)) continue;
    const list = shiftsByEmployee.get(s.employeeId) ?? [];
    list.push(s);
    shiftsByEmployee.set(s.employeeId, list);
  }

  const lines: EmployeeBreakdown[] = [];
  const gaps: RevenueGap[] = [];

  for (const employee of input.employees) {
    if (!employee.active) continue;

    const level = levelById.get(employee.levelId);
    if (!level) {
      throw new Error(`Employee ${employee.id} references unknown level ${employee.levelId}`);
    }

    const empShifts = shiftsByEmployee.get(employee.id) ?? [];
    let hourlyPay = 0;
    let revenueShare = 0;
    // Revenue share is a per-employee-per-location-day quantity: an employee
    // earns their percent of a given day's revenue at most once, even if the
    // input contains multiple shifts for that location/day. Hourly pay, by
    // contrast, accrues per shift (each shift is worked hours). The schema's
    // UNIQUE (employee_id, work_date) makes duplicates unreachable with valid
    // data; this guard keeps the engine correct regardless of its input.
    const countedDays = new Set<string>();

    for (const shift of empShifts) {
      const location = locationById.get(shift.locationId);
      if (!location) {
        throw new Error(`Shift ${shift.id} references unknown location ${shift.locationId}`);
      }
      hourlyPay += level.ratePerHour * location.standardShiftHours;

      const dayKey = revenueKey(shift.locationId, shift.workDate);
      if (countedDays.has(dayKey)) continue;
      countedDays.add(dayKey);

      const revenue = revenueByKey.get(dayKey);
      if (revenue === undefined) {
        gaps.push({ employeeId: employee.id, locationId: shift.locationId, date: shift.workDate });
      } else {
        revenueShare += employee.revenuePercent * revenue;
      }
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @salary/core test calculateSalaries`
Expected: PASS — all calculation tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/calculateSalaries.ts packages/core/test/calculateSalaries.test.ts
git commit -m "Add salary calculation engine"
```

---

### Task 4: Database schema + PGlite validation

**Files:**
- Create: `packages/core/db/migrations/0001_init.sql`
- Test: `packages/core/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: the `0001_init.sql` migration (consumed by the API and infrastructure plans). Table/column names match the `types.ts` fields in snake_case.

- [ ] **Step 1: Write the schema migration**

`packages/core/db/migrations/0001_init.sql`:
```sql
CREATE TYPE shift_status AS ENUM ('requested', 'approved', 'rejected');
CREATE TYPE shift_source AS ENUM ('native', 'extracted');
CREATE TYPE revenue_source AS ENUM ('manual', 'extracted');
CREATE TYPE revenue_status AS ENUM ('pending', 'needs_review', 'approved', 'rejected');
CREATE TYPE doc_type AS ENUM ('revenue', 'schedule');
CREATE TYPE extraction_status AS ENUM ('processing', 'needs_review', 'approved', 'rejected');

CREATE TABLE levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  rate_per_hour NUMERIC(10, 2) NOT NULL CHECK (rate_per_hour >= 0)
);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  standard_shift_hours NUMERIC(5, 2) NOT NULL CHECK (standard_shift_hours > 0)
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  level_id UUID NOT NULL REFERENCES levels (id),
  revenue_percent NUMERIC(6, 4) NOT NULL DEFAULT 0 CHECK (revenue_percent >= 0 AND revenue_percent <= 1),
  cognito_sub TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees (id),
  location_id UUID NOT NULL REFERENCES locations (id),
  work_date DATE NOT NULL,
  status shift_status NOT NULL DEFAULT 'requested',
  source shift_source NOT NULL DEFAULT 'native',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);

CREATE TABLE daily_revenue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations (id),
  revenue_date DATE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  source revenue_source NOT NULL DEFAULT 'manual',
  status revenue_status NOT NULL DEFAULT 'approved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, revenue_date)
);

CREATE TABLE extraction_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type doc_type NOT NULL,
  s3_key TEXT NOT NULL,
  status extraction_status NOT NULL DEFAULT 'processing',
  confidence NUMERIC(4, 3),
  extracted_json JSONB,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE salary_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_start, period_end)
);

CREATE TABLE salary_run_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES salary_runs (id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees (id),
  hourly_pay NUMERIC(12, 2) NOT NULL,
  revenue_share NUMERIC(12, 2) NOT NULL,
  bonus NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  UNIQUE (run_id, employee_id)
);
```

- [ ] **Step 2: Write the failing schema test**

`packages/core/test/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../db/migrations/0001_init.sql'), 'utf8');

const LEVEL = '11111111-1111-1111-1111-111111111111';
const LOC = '22222222-2222-2222-2222-222222222222';
const EMP = '33333333-3333-3333-3333-333333333333';

describe('schema 0001_init', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(migration);
    await db.exec(`
      INSERT INTO levels (id, name, rate_per_hour) VALUES ('${LEVEL}', 'Junior', 20.00);
      INSERT INTO locations (id, name, standard_shift_hours) VALUES ('${LOC}', 'Downtown', 8.00);
      INSERT INTO employees (id, name, level_id, revenue_percent)
        VALUES ('${EMP}', 'Alice', '${LEVEL}', 0.0500);
    `);
  });

  it('stores and reads a shift', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${EMP}', '${LOC}', '2026-08-03');`,
    );
    const res = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM shifts;');
    expect(res.rows[0].count).toBe('1');
  });

  it('enforces one shift per employee per day', async () => {
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${EMP}', '${LOC}', '2026-08-03');`,
      ),
    ).rejects.toThrow();
  });

  it('enforces one revenue row per location per day', async () => {
    await db.exec(
      `INSERT INTO daily_revenue (location_id, revenue_date, amount) VALUES ('${LOC}', '2026-08-03', 1000.00);`,
    );
    await expect(
      db.exec(
        `INSERT INTO daily_revenue (location_id, revenue_date, amount) VALUES ('${LOC}', '2026-08-03', 500.00);`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a revenue_percent above 1', async () => {
    await expect(
      db.exec(
        `INSERT INTO employees (name, level_id, revenue_percent) VALUES ('Bad', '${LEVEL}', 1.5);`,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @salary/core test schema`
Expected: FAIL — `0001_init.sql` not found, or (if created empty) inserts fail because tables are missing.

- [ ] **Step 4: Run the test to verify it passes**

After the migration file from Step 1 is in place, run: `pnpm --filter @salary/core test schema`
Expected: PASS — 4 schema tests green (PGlite applies the DDL, the shift/revenue uniqueness constraints and the `revenue_percent` check all fire).

- [ ] **Step 5: Commit**

```bash
git add packages/core/db/migrations/0001_init.sql packages/core/test/schema.test.ts
git commit -m "Add database schema with PGlite validation"
```

---

### Task 5: Public API barrel + typecheck gate

**Files:**
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: every module built in Tasks 1–4.
- Produces: the `@salary/core` public surface — re-exports of all types and functions, so consumers write `import { calculateSalaries, type Employee } from '@salary/core'`.

- [ ] **Step 1: Create the barrel export**

`packages/core/src/index.ts`:
```ts
export * from './types';
export { round2 } from './money';
export { payPeriodsForMonth, isWithinPeriod } from './payPeriod';
export { calculateSalaries } from './calculateSalaries';
```

- [ ] **Step 2: Run the typecheck to verify the package compiles**

Run: `pnpm --filter @salary/core typecheck`
Expected: PASS — `tsc --noEmit` reports no errors.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --filter @salary/core test`
Expected: PASS — all money, pay-period, calculation, and schema tests green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "Export core public API"
```

---

## Self-Review

**Spec coverage (against `2026-08-03-salary-calculator-design.md`):**
- §3 formula (hourly = rate × shift hours; revenue share = % × daily revenue per worked shift; bonus; total) → Task 3.
- §3 revenue-by-shift, full % per person independent of hours/other staff → Task 3 tests.
- §3 fixed pay periods 1–15 / 16–end → Task 2.
- §3 blocker rule for missing approved revenue → Task 3 (`gaps`/`blocked`).
- §3 one-shot run snapshot columns → `salary_run_lines` in Task 4.
- §4 full data model (levels, locations, employees, shifts, daily_revenue, extraction_jobs, salary_runs, salary_run_lines) → Task 4.
- §5 shift status/source enums → Task 4; consumed by Task 3 filter.
- §6 extraction_jobs table (doc_type, s3_key, status, confidence, extracted_json, reviewed_by) → Task 4. (The extraction *pipeline* itself is a later plan.)
- §7 API/infra/frontend → intentionally out of scope for this plan (later plans).

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every step has concrete code or an exact command.

**Type consistency:** `PayPeriod` (Task 2) is reused by `calculateSalaries` (Task 3); `round2` (Task 1) used in Task 3; `Shift`/`RevenueStatus` unions defined in Task 3 match the enum values in the Task 4 DDL (`requested|approved|rejected`, `pending|needs_review|approved|rejected`). Barrel (Task 5) re-exports exactly the produced symbols.
