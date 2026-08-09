# Pay Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move both pay parameters — the guaranteed day rate (ставка) and the revenue percent — into a level × location matrix; a level becomes a pure label, and a shift at an unconfigured (level, location) blocks the salary run.

**Architecture:** New `pay_rates` table keyed `(level_id, location_id)` carrying `rate_per_day` + `revenue_percent`; `calculateSalaries` resolves both per shift from the shift's own location and reports missing cells as blocking gaps; a new admin CRUD route; a Setup matrix panel. Precondition: the migrate Lambda gets a journal table so migration 0008 can ever apply.

**Tech Stack:** Existing stack — Drizzle/PGlite tests, RDS Data API production, Hono, React + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-revenue-percent-matrix-design.md` (revised 2026-08-09, approved).

## Global Constraints

- Migrations: TEXT + CHECK, never Postgres enums. After editing SQL run `pnpm --filter @salary/core generate:migrations`, add the named export in `packages/core/src/migrations.ts`, extend `packages/core/test/migrations.test.ts`. All three or the suite goes red.
- The Data API's ExecuteStatement takes ONE statement; the handler already splits. Any new handler SQL must be single statements.
- DATE values are `YYYY-MM-DD` strings — never `new Date(iso)` on them. TIME values go through `toSqlTime()`.
- All UI copy in `apps/web/src/lib/i18n.ts`; Ukrainian plurals via 3-form `plural(n, one, few, many)`; money never through `Intl.NumberFormat`.
- `revenue_percent` is a 0..1 fraction in DB/API; the UI renders and accepts percentages (3 ↔ 0.03).
- Extensionless relative imports. No `Co-Authored-By`/generated-with trailers on commits — ever.
- After your task: `pnpm -r test` and `pnpm -r typecheck` must be green (if `packages/api/test/bundle.test.ts` is stale, run `pnpm --filter @salary/api bundle` and re-run).
- Web tests for hooks/components: real hooks + stubbed `fetch` (see `apps/web/test/queries.test.tsx`, `schedule-grid.test.tsx`) — never mock `../src/lib/queries` wholesale.

---

### Task 1: Migration journal table

The migrate Lambda re-runs from 0001 and fails loudly on an existing schema (`migrationHandler.ts` documents this). Migration 0008 cannot apply to a live DB until this is fixed.

**Files:**
- Modify: `packages/api/src/migrationHandler.ts`
- Test: `packages/api/test/migration-journal.test.ts` (create)

**Interfaces:**
- Produces: handler return shape becomes `{ applied: number; skipped: number; errors: string[] }`.
- The journal table is created BY the handler itself (idempotent `CREATE TABLE IF NOT EXISTS`), not by a numbered migration — the runner must not depend on the thing it runs.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/test/migration-journal.test.ts
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATION_NAMES } from '@salary/core/migrations.generated';
import { runMigrations } from '../src/migrationHandler';

/** Adapter: the journal logic runs statements through this narrow interface, so tests
 *  drive it with PGlite while production drives it with the Data API client. */
function pgliteExecutor(db: PGlite) {
  return async (sql: string) => {
    const res = await db.query(sql);
    return res.rows as Record<string, unknown>[];
  };
}

describe('migration journal', () => {
  it('applies everything to an empty database and records each name', async () => {
    const db = new PGlite();
    const result = await runMigrations(pgliteExecutor(db));
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(MIGRATION_NAMES.length);
    expect(result.skipped).toBe(0);
    const rows = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.rows.map((r: { name: string }) => r.name)).toEqual([...MIGRATION_NAMES].sort());
  });

  it('is idempotent: a second run applies nothing and fails nothing', async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const again = await runMigrations(pgliteExecutor(db));
    expect(again.errors).toEqual([]);
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(MIGRATION_NAMES.length);
  });

  it('adopts a pre-journal database: schema exists, journal does not', async () => {
    /* The deployed DB was migrated before the journal existed. The handler must detect
     * an existing schema (levels table present, journal absent), seed the journal with
     * every migration name WITHOUT re-running them, and then apply only what's new. */
    const db = new PGlite();
    // Simulate the pre-journal world: run all migrations directly, no journal.
    const { MIGRATIONS } = await import('@salary/core/migrations');
    const { splitSqlStatements } = await import('@salary/core');
    for (const sql of MIGRATIONS) for (const s of splitSqlStatements(sql)) await db.query(s);

    const result = await runMigrations(pgliteExecutor(db));
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(MIGRATION_NAMES.length);
  });

  it('applies only the tail when the journal is behind', async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    // Un-record the last migration and drop nothing — pretend it never ran by removing
    // its journal row after applying a fresh DB minus that migration is impractical;
    // instead verify the selection logic directly: delete the last row, re-run, and
    // expect exactly one 'applied' attempt (it will error on already-existing objects,
    // proving it was ATTEMPTED — the selection is what's under test).
    const last = [...MIGRATION_NAMES].sort().at(-1)!;
    await db.query(`DELETE FROM schema_migrations WHERE name = '${last}'`);
    const result = await runMigrations(pgliteExecutor(db));
    expect(result.skipped).toBe(MIGRATION_NAMES.length - 1);
    // applied + errored-on-attempt accounts for the one unrecorded migration
    expect(result.applied + result.errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect failure** (`runMigrations` is not exported): `pnpm --filter @salary/api exec vitest run test/migration-journal.test.ts`

- [ ] **Step 3: Restructure the handler around an executor function**

```ts
// packages/api/src/migrationHandler.ts
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { MIGRATIONS } from '@salary/core/migrations';
import { MIGRATION_NAMES } from '@salary/core/migrations.generated';
import { splitSqlStatements } from '@salary/core';
import { readDbEnvConfig } from './db/prodDb';

type Executor = (sql: string) => Promise<Record<string, unknown>[]>;

export interface MigrateResult {
  applied: number;
  skipped: number;
  errors: string[];
}

/**
 * Apply migrations with a journal.
 *
 * The journal (`schema_migrations`) is created by the runner itself, not by a numbered
 * migration — the runner cannot depend on the thing it runs. Three situations:
 *
 *  1. Empty DB: journal is created, every migration applies, every name is recorded.
 *  2. Pre-journal DB (the deployed state before this handler shipped): the schema exists
 *     but the journal doesn't. Detected via `to_regclass('public.levels')` — the very
 *     first table 0001 creates. The journal is seeded with EVERY known name without
 *     re-running anything: those migrations are visibly already applied, and re-running
 *     0001 fails loudly by design.
 *  3. Journal present: apply exactly the migrations whose names are not recorded.
 *
 * Names come from MIGRATION_NAMES (filename-sorted, same order as MIGRATIONS) so the
 * journal rows and the SQL list can never disagree about identity.
 */
export async function runMigrations(execute: Executor): Promise<MigrateResult> {
  await execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );

  const journalRows = await execute('SELECT name FROM schema_migrations');
  const recorded = new Set(journalRows.map((r) => String(r.name)));

  if (recorded.size === 0) {
    // Journal is empty — but is the schema? to_regclass returns NULL (not an error) for a
    // missing relation, so this probe is safe on a genuinely empty database.
    const probe = await execute("SELECT to_regclass('public.levels') AS t");
    const schemaExists = probe.length > 0 && probe[0].t != null;
    if (schemaExists) {
      for (const name of MIGRATION_NAMES) {
        await execute(`INSERT INTO schema_migrations (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING`);
        recorded.add(name);
      }
    }
  }

  const errors: string[] = [];
  let applied = 0;
  let skipped = 0;

  for (const [index, sql] of MIGRATIONS.entries()) {
    const name = MIGRATION_NAMES[index];
    if (recorded.has(name)) {
      skipped += 1;
      continue;
    }
    const statements = splitSqlStatements(sql);
    try {
      for (const [stmtIndex, statement] of statements.entries()) {
        try {
          await execute(statement);
        } catch (err) {
          throw new Error(
            `statement ${stmtIndex + 1}/${statements.length} (${statement.slice(0, 80).replace(/\s+/g, ' ')}…): ${(err as Error).message}`,
          );
        }
      }
      await execute(`INSERT INTO schema_migrations (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING`);
      applied += 1;
    } catch (err) {
      errors.push(`migration ${name}: ${(err as Error).message}`);
      break; // later migrations assume earlier ones applied
    }
  }

  return { applied, skipped, errors };
}

/** Lambda entry point: the executor is the RDS Data API. */
export async function handler(): Promise<MigrateResult> {
  const config = readDbEnvConfig(process.env);
  const client = new RDSDataClient({ region: config.region });
  return runMigrations(async (sql) => {
    const res = await client.send(
      new ExecuteStatementCommand({
        resourceArn: config.resourceArn,
        secretArn: config.secretArn,
        database: config.dbName,
        sql,
        includeResultMetadata: true,
      }),
    );
    // Reduce the Data API's column/field structure to name->value records; only the
    // journal SELECT and the to_regclass probe read results.
    const cols = (res.columnMetadata ?? []).map((c) => c.name ?? '');
    return (res.records ?? []).map((rec) =>
      Object.fromEntries(rec.map((f, i) => [cols[i], f.stringValue ?? f.longValue ?? (f.isNull ? null : undefined)])),
    );
  });
}
```

Check `migrations.generated.ts` actually exports `MIGRATION_NAMES` (it does — `migrations.ts` imports it); if the import path `@salary/core/migrations.generated` is not an exposed subpath in core's `package.json` exports map, re-export `MIGRATION_NAMES` from `@salary/core/migrations` instead and import from there (both in the handler and the test).

- [ ] **Step 4: Run the journal tests, then the full suite**: `pnpm --filter @salary/api exec vitest run test/migration-journal.test.ts`, then `pnpm -r test` (rebundle if the bundle test is stale).

- [ ] **Step 5: Commit** — `git commit -m "Add a migration journal so additive migrations can apply to a live database"`

---

### Task 2: Migration 0008 + core types + calculateSalaries

**Files:**
- Create: `packages/core/db/migrations/0008_pay_matrix.sql`
- Modify: `packages/core/src/migrations.ts`, `packages/core/src/types.ts`, `packages/core/src/calculateSalaries.ts`, `packages/core/src/index.ts` (exports if needed)
- Modify: `packages/api/src/schema.ts` (Drizzle table; drop the two columns)
- Test: `packages/core/test/migrations.test.ts` (extend), `packages/core/test/calculateSalaries.test.ts` (rework), `packages/api/test/schema.test.ts` (constraint checks)

**Interfaces:**
- Produces (used by Tasks 3–5):
  ```ts
  export interface PayRate { levelId: string; locationId: string; ratePerDay: number; revenuePercent: number; }
  export interface MissingRate { levelId: string; locationId: string; }
  // CalcInput: levels: { id; name }[]; employees lose revenuePercent; new payRates: PayRate[]
  // CalcResult: gains missingRates: MissingRate[]; blocked = gaps.length > 0 || missingRates.length > 0
  ```

- [ ] **Step 1: The migration**

```sql
-- 0008_pay_matrix.sql
--
-- Both pay parameters move to a (level, location) matrix. A level becomes a pure label:
-- the same level pays a different guaranteed day rate AND a different revenue percent at
-- different locations. The old single-grain columns drop outright — production was
-- recreated empty on 2026-08-09 and committed salary runs snapshot their own figures, so
-- nothing historical reads these columns.
--
-- ON DELETE CASCADE: matrix cells are configuration, not payroll history. Deleting a
-- level or location takes its cells along instead of blocking on an FK that protects
-- nothing (history lives in salary_run_lines).

CREATE TABLE pay_rates (
  level_id        UUID NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  rate_per_day    NUMERIC(10,2) NOT NULL CHECK (rate_per_day >= 0),
  revenue_percent NUMERIC(6,5)  NOT NULL DEFAULT 0 CHECK (revenue_percent >= 0 AND revenue_percent <= 1),
  PRIMARY KEY (level_id, location_id)
);

ALTER TABLE levels DROP COLUMN rate_per_day;

ALTER TABLE employees DROP COLUMN revenue_percent;
```

- [ ] **Step 2: Regenerate + register**: `pnpm --filter @salary/core generate:migrations`; in `migrations.ts` add `export const PAY_MATRIX_SQL = read('0008_pay_matrix.sql');` with doc comment `/** Day rate and revenue percent become a (level, location) matrix; a level is a pure label. */`; extend the ordered list in `migrations.test.ts`.

- [ ] **Step 3: Types** — in `packages/core/src/types.ts`:

```ts
export interface Level {
  id: string;
  name: string;
}

export interface Employee {
  id: string;
  name: string;
  levelId: string;
  cognitoSub: string | null;
  active: boolean;
}

/** One matrix cell: what a level is paid at a location. */
export interface PayRate {
  levelId: string;
  locationId: string;
  /** Guaranteed pay for a full working day at this location (грн). */
  ratePerDay: number;
  /** Fraction in [0, 1]; 0.05 = 5%. */
  revenuePercent: number;
}

/** A worked (level, location) with no configured pay_rates cell. Blocks the run. */
export interface MissingRate {
  levelId: string;
  locationId: string;
}
```

`CalcInput` gains `payRates: PayRate[]`; `CalcResult` gains `missingRates: MissingRate[]`.

- [ ] **Step 4: Failing tests first** — rework `calculateSalaries.test.ts`. Keep every existing scenario (they encode the proration rules) but feed the matrix; add:

```ts
it('pays different rates and percents for the same person at two locations in one day', () => {
  // loc A: 12h day, 600/day, 5%; loc B: 12h day, 800/day, 10%. 6h at each.
  // revenue 1000 approved at each location; the employee is the only worker.
  // base = 600*(6/12) + 800*(6/12) = 300 + 400 = 700
  // share = 0.05*1000*(6/6) + 0.10*1000*(6/6) = 50 + 100 = 150
  const result = calculateSalaries(input, period);
  expect(result.lines[0].hourlyPay).toBe(700);
  expect(result.lines[0].revenueShare).toBe(150);
  expect(result.blocked).toBe(false);
});

it('reports a missing matrix cell as a blocking gap and pays nothing for that shift', () => {
  // Same fixture minus the (level, locB) cell. The locA shift still computes; the locB
  // shift contributes NOTHING to either component and lands in missingRates.
  const result = calculateSalaries(input, period);
  expect(result.missingRates).toEqual([{ levelId: level.id, locationId: locB.id }]);
  expect(result.blocked).toBe(true);
  expect(result.lines[0].hourlyPay).toBe(300); // locA half-day only
});

it('dedupes missingRates across shifts and employees sharing the cell', () => { /* two employees, same level, both at locB twice -> one entry */ });

it('a configured cell with percent 0 pays rate only', () => { /* share component is 0, hourlyPay normal, not blocked */ });
```

- [ ] **Step 5: Implementation** — in `calculateSalaries.ts`, replace the level-rate and employee-percent reads:

```ts
const rateByCell = new Map(input.payRates.map((r) => [`${r.levelId}|${r.locationId}`, r]));
const missingCells = new Set<string>();
// ... inside the per-shift loop, replacing the two old formulas:
const cell = rateByCell.get(`${employee.levelId}|${shift.locationId}`);
if (!cell) {
  // No configured pay for this level at this location. This blocks the run — the day
  // rate is the person's base wage, and writing 0 silently is the one unforgivable
  // failure in a payroll app. The shift contributes to NEITHER component and does not
  // create a revenue gap of its own (the run is already blocked; reporting the same
  // shift twice as two kinds of gap is noise).
  missingCells.add(`${employee.levelId}|${shift.locationId}`);
  continue;
}
hourlyPay += cell.ratePerDay * (hours / locationDayHours);
// ... revenue share as before but with cell.revenuePercent:
revenueShare += cell.revenuePercent * revenue * (hours / totalHours);
```

Assemble `missingRates` from `missingCells` (split on `|`), and `blocked: gaps.length > 0 || missingRates.length > 0`. Keep the existing gap logic untouched for shifts that HAVE a cell. Note the `continue` placement: the missing-cell check comes BEFORE the revenue-gap check, so a missing-cell shift produces exactly one kind of gap.

- [ ] **Step 6: Drizzle schema** — in `packages/api/src/schema.ts`: remove `ratePerDay` from `levels`, `revenuePercent` from `employees`; add:

```ts
export const payRates = pgTable(
  'pay_rates',
  {
    levelId: uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    ratePerDay: numeric('rate_per_day', { precision: 10, scale: 2 }).notNull(),
    revenuePercent: numeric('revenue_percent', { precision: 6, scale: 5 }).notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.levelId, t.locationId] })],
);
```

(Match the existing style in schema.ts for the table-config callback — if neighbors use the object form, use that.) Extend `packages/api/test/schema.test.ts` with a rejected write per CHECK: negative `rate_per_day`, `revenue_percent` of `1.5`.

- [ ] **Step 7: Expect API/web breakage, fix ONLY compile errors in this task's files.** The API routes still reference the dropped columns — that is Task 3. To keep this task's suite green without scope creep, this task may leave `pnpm -r typecheck` RED for `@salary/api`/`@salary/web` ONLY if Task 3 lands in the same review window — otherwise coordinate with the controller. Preferred: Tasks 2 and 3 are reviewed together as one commit range. Run `pnpm --filter @salary/core test` green before commit.

- [ ] **Step 8: Commit** — `git commit -m "Move day rate and revenue percent into a pay_rates matrix (core)"`

---

### Task 3: API — pay-rates route, levels/employees cleanup, salary-run blocking

**Files:**
- Create: `packages/api/src/routes/payRates.ts`
- Modify: `packages/api/src/routes/levels.ts`, `packages/api/src/routes/employees.ts`, `packages/api/src/routes/salaryRuns.ts`, `packages/api/src/app.ts` (mount route)
- Test: `packages/api/test/pay-rates.test.ts` (create), `packages/api/test/salary-runs.test.ts` (extend), `packages/api/test/levels.test.ts` + `employees.test.ts` (update)

**Interfaces:**
- Consumes: `payRates` Drizzle table, `PayRate`/`MissingRate` from core (Task 2).
- Produces (Task 4 relies on these exactly):
  - `GET /api/pay-rates` → `PayRate[]` (manager/admin)
  - `PUT /api/pay-rates` body `{ levelId, locationId, ratePerDay, revenuePercent? }` → upserted `PayRate` (admin)
  - `DELETE /api/pay-rates?levelId=&locationId=` → `{ deleted: boolean }` (admin; 400 missing params)
  - Run preview/commit 409 body gains `missingRates: MissingRate[]` alongside `gaps`.

- [ ] **Step 1: Failing route tests**

```ts
// packages/api/test/pay-rates.test.ts — seed a level + location, then:
it('upserts a cell and reads it back', async () => {
  const put = await app.request('/api/pay-rates', { method: 'PUT', headers: ADMIN,
    body: JSON.stringify({ levelId, locationId, ratePerDay: 600, revenuePercent: 0.05 }) });
  expect(put.status).toBe(200);
  const list = await (await app.request('/api/pay-rates', { headers: MGR })).json();
  expect(list).toEqual([{ levelId, locationId, ratePerDay: 600, revenuePercent: 0.05 }]);
  // Upsert: PUT again with a new rate, still exactly one row.
  await app.request('/api/pay-rates', { method: 'PUT', headers: ADMIN,
    body: JSON.stringify({ levelId, locationId, ratePerDay: 650 }) });
  const after = await (await app.request('/api/pay-rates', { headers: MGR })).json();
  expect(after).toEqual([{ levelId, locationId, ratePerDay: 650, revenuePercent: 0 }]);
  // NOTE the second PUT omitted revenuePercent -> the zod default (0) applies on upsert;
  // this is deliberate (the PUT body is the full cell state, not a patch).
});
it('percent defaults to 0', /* PUT without revenuePercent -> 0 in response */);
it('rejects out-of-range values with 400', /* ratePerDay: -1; revenuePercent: 1.5 */);
it('manager can read but not write', /* GET 200, PUT 403, DELETE 403 */);
it('employee can do neither', /* GET 403 */);
it('deletes a cell', /* DELETE -> {deleted:true}; second DELETE -> {deleted:false}; 400 without params */);
```

- [ ] **Step 2: The route**

```ts
// packages/api/src/routes/payRates.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { payRates } from '../schema';
import type { Db } from '../db/types';

const putSchema = z.object({
  levelId: z.string().uuid(),
  locationId: z.string().uuid(),
  ratePerDay: z.number().nonnegative(),
  revenuePercent: z.number().min(0).max(1).default(0),
});

function toDto(row: typeof payRates.$inferSelect) {
  return {
    levelId: row.levelId,
    locationId: row.locationId,
    ratePerDay: Number(row.ratePerDay),
    revenuePercent: Number(row.revenuePercent),
  };
}

export function payRatesRoutes(db: Db) {
  const routes = new Hono<AppEnv>();

  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(payRates);
    return c.json(rows.map(toDto));
  });

  routes.put('/', requireRole('admin'), async (c) => {
    const parsed = putSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: `validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }, 400);
    const body = parsed.data;
    const [row] = await db
      .insert(payRates)
      .values({
        levelId: body.levelId,
        locationId: body.locationId,
        ratePerDay: String(body.ratePerDay),
        revenuePercent: String(body.revenuePercent),
      })
      .onConflictDoUpdate({
        target: [payRates.levelId, payRates.locationId],
        set: { ratePerDay: String(body.ratePerDay), revenuePercent: String(body.revenuePercent) },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/', requireRole('admin'), async (c) => {
    const levelId = c.req.query('levelId');
    const locationId = c.req.query('locationId');
    if (!levelId || !locationId) return c.json({ error: 'levelId and locationId are required' }, 400);
    const deleted = await db
      .delete(payRates)
      .where(and(eq(payRates.levelId, levelId), eq(payRates.locationId, locationId)))
      .returning();
    return c.json({ deleted: deleted.length > 0 });
  });

  return routes;
}
```

Match the actual error-shape/validation idiom used by sibling routes (read `appSettings.ts` first — if it uses `zValidator` or a shared helper, copy that instead of hand-rolled safeParse). Mount in `app.ts` next to the other routes: `app.route('/api/pay-rates', payRatesRoutes(db))`. The FK violation on an unknown levelId/locationId will surface as a 500 — acceptable for an admin-only endpoint fed by dropdowns of existing entities; add a test documenting whichever behavior you implement.

- [ ] **Step 3: levels.ts / employees.ts** — remove `ratePerDay` and `revenuePercent` from zod schemas, insert/patch values, and DTOs. Update their tests. Where a test previously asserted the field round-trips, the replacement asserts the field is ABSENT from the response (a removed field that quietly returns is drift).

- [ ] **Step 4: salaryRuns.ts** — load the matrix and pass it through; surface `missingRates`:

```ts
// alongside the existing loads:
const rates = await db.select().from(payRates);
// CalcInput:
payRates: rates.map((r) => ({
  levelId: r.levelId, locationId: r.locationId,
  ratePerDay: Number(r.ratePerDay), revenuePercent: Number(r.revenuePercent),
})),
levels: lvls.map((l) => ({ id: l.id, name: l.name })),
// employees mapping loses revenuePercent
```

The preview response and the commit-refusal 409 both include `missingRates: result.missingRates` next to `gaps`. The commit guard becomes `if (result.blocked)` (it already is — `blocked` now also covers missing rates via Task 2).

- [ ] **Step 5: Salary-run integration test** (extend `salary-runs.test.ts`):

```ts
it('blocks a run and names the missing (level, location) cells', async () => {
  // employee works two locations; only one has a pay_rates cell; both have approved revenue.
  const res = await app.request('/api/salary-runs', { method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9, half: 1 }) });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.missingRates).toEqual([{ levelId, locationId: locB }]);
});
it('computes different rates per location in one committed run', /* both cells configured; assert the line total matches the two-location arithmetic from the core test */);
```

- [ ] **Step 6: Full verification** — `pnpm -r test` and `pnpm -r typecheck` green (web will still compile: it references `ratePerDay`/`revenuePercent` in its own interfaces — those are Task 4's to remove; if apps/web typecheck breaks because it consumed a core type directly, fix only the type import, not the UI).

- [ ] **Step 7: Commit** — `git commit -m "Add pay-rates API and block salary runs on missing matrix cells"`

---

### Task 4: Web data layer — hooks + i18n

**Files:**
- Modify: `apps/web/src/lib/queries.ts`, `apps/web/src/lib/i18n.ts`
- Test: `apps/web/test/queries.test.tsx` (extend — real hooks + stubbed fetch, same pattern as the day-off hooks)

**Interfaces:**
- Consumes: Task 3's endpoints exactly.
- Produces (Task 5 relies on these):

```ts
export interface PayRateDto { levelId: string; locationId: string; ratePerDay: number; revenuePercent: number; }

export function usePayRates() {
  const api = useApi();
  return useQuery({ queryKey: ['pay-rates'], queryFn: () => api.get<PayRateDto[]>('/api/pay-rates') });
}

/** Upsert one matrix cell. The body is the full cell state, not a patch. */
export function useSetPayRate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { levelId: string; locationId: string; ratePerDay: number; revenuePercent?: number }) =>
      api.put<PayRateDto>('/api/pay-rates', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pay-rates'] });
      // The matrix is a payroll input: a changed cell changes what a future run pays.
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export function useClearPayRate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ levelId, locationId }: { levelId: string; locationId: string }) =>
      api.del<{ deleted: boolean }>(`/api/pay-rates?levelId=${levelId}&locationId=${locationId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pay-rates'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}
```

Also: remove `ratePerDay` from the `Level` interface and `revenuePercent` from `Employee`; remove them from `useAddLevel`/`useUpdateLevel`/`useAddEmployee`/`useUpdateEmployee` bodies. `SalaryRun` preview/commit response types gain `missingRates: { levelId: string; locationId: string }[]`.

i18n group (final Ukrainian copy — adjust only if a native-speaker reviewer objects):

```ts
payMatrix: {
  title: 'Оплата по локаціях',
  hint: 'Ставка за день і відсоток від виручки для кожного рівня на кожній локації. Порожня клітинка блокує розрахунок зарплати для цієї комбінації.',
  ratePerDay: 'Ставка, грн/день',
  revenuePercent: '% від виручки',
  notConfigured: 'не задано',
  clearConfirm: 'Прибрати оплату для цієї комбінації? Розрахунок зарплати буде заблоковано, поки її не задано знову.',
  missingTitle: 'Не задано оплату',
  missingHint: 'Розрахунок заблоковано: для цих комбінацій рівня і локації не задано ставку.',
},
```

Tests: each hook's real request captured from stubbed fetch (URL, method, body incl. the percent default omitted vs sent), same file/pattern as the existing day-off hook tests.

- [ ] **Steps:** failing tests → implement → `pnpm --filter @salary/web test` + typecheck → commit `"Add pay-matrix hooks and copy; drop rate/percent from level and employee types"`.

---

### Task 5: Matrix UI + levels/employee cleanup + blocked-run screen

**Agent:** design-developer (this is UI work; the agent reads `docs/design/system.md` first, per its definition).

**Files:**
- Create: `apps/web/src/components/PayMatrixPanel.tsx` (+ its CSS following the codebase's pattern)
- Modify: `apps/web/src/routes/SetupRoute.tsx` (mount panel; remove the rate field from the levels panel), `apps/web/src/routes/EmployeesRoute.tsx` (remove the percent field), `apps/web/src/routes/RunsRoute.tsx` (blocked preview lists missing cells as links to Setup)
- Test: `apps/web/test/pay-matrix.test.tsx` (create), existing route tests (update)

**Interfaces:** Consumes Task 4's hooks and i18n keys verbatim.

**Requirements (behavioral spec — the design agent owns the concrete markup):**

1. **The matrix**: levels as rows, locations as columns. Each cell: two mono inputs (rate; percent). Percent is entered as a percentage and divided by 100 on write (`3` → `0.03`); rate as entered. Display formats: rate via the codebase's money formatting (2 decimals), percent as `×100` with up to 2 decimals.
2. Commit a cell on blur or Enter of either field IF both are valid and at least the rate is present; a PUT sends the FULL cell (both values — read the other field's current state).
3. An unconfigured cell shows `t.payMatrix.notConfigured` muted and empty inputs — visually distinct because it blocks payroll, but NOT `--stop` colored (that is reserved for blocked runs themselves).
4. Clearing both fields of a configured cell → confirm with `t.payMatrix.clearConfirm` → DELETE.
5. Admin-only: the panel renders for admins; managers don't see it (match how existing admin-only setup panels gate).
6. Levels panel loses its rate input/column; employee card loses its percent field.
7. **RunsRoute**: when preview returns non-empty `missingRates`, render `t.payMatrix.missingTitle` + `missingHint` and one line per cell — "<level name> — <location name>" — as a link to Setup (`/setup`). Names resolve from the already-loaded levels/locations lists. This blocks commit exactly like revenue gaps (the API already refuses; the UI must explain).
8. 390px: the matrix collapses per the established ≤720px pattern (one block per level, locations as labeled rows within it).
9. Tests (real hooks + stubbed fetch): typing rate 600 + percent 3 in a cell PUTs `{ratePerDay: 600, revenuePercent: 0.03}`; clearing fires the confirm then DELETE; a preview with missingRates renders the level/location names; the panel is absent for a manager token.

- [ ] **Steps:** failing tests → implement per design system → design self-audit (archetype, amber count, 390px) → `pnpm -r test` + typecheck → commit `"Add the pay-matrix setup panel and blocked-run explanations"`.

---

### Task 6: Deploy and verify on the live Data API

**Files:** none (deployment only). Same command set as the Stage-1 deploy (see `.superpowers/sdd/sa/task-9-brief.md` Steps 1–5 for exact commands — bundle, zip, `aws lambda update-function-code` × 2, invoke migrate, S3 sync + CloudFront invalidation, all with `AWS_PROFILE=yevhenii`).

- [ ] **Step 1: Deploy Lambdas** (bundle → zip → update-function-code × 2 → wait Successful).
- [ ] **Step 2: Invoke the migrate Lambda.** Expected NOW (journal exists as of Task 1): `{"applied":1,"skipped":7,"errors":[]}` — 0008 applies, 0001–0007 skip via the journal's adoption path. If the response shows `applied: 0, errors: [...]`, STOP and read the error — do not drop the schema this time; the journal exists precisely so recreation is never again the fix.
- [ ] **Step 3: Live verification** (single session, token held in a shell variable only — never written to a file):
  - `PUT /api/pay-rates` a cell → 200 with both numbers back (NUMERIC round-trip through the Data API).
  - `GET /api/pay-rates` → the cell.
  - Create a second location with NO cell, a draft shift there, publish, then `POST /api/salary-runs/preview` → `missingRates` names the cell and `blocked: true`.
  - `DELETE` the fixture cell; clean up fixtures.
- [ ] **Step 4: Frontend** — build, S3 sync, CloudFront invalidation.
- [ ] **Step 5: Browser walkthrough** — Налаштування → fill the matrix for real levels/locations; Працівники → confirm no percent field; Runs → confirm a blocked preview names missing cells.
- [ ] **Step 6: Commit any fixes**; note verification results in the ledger.

---

## Self-Review

**Spec coverage:** §2.1 one matrix two values → Tasks 2, 3, 5. §2.2 missing cell blocks → Tasks 2 (core), 3 (409), 5 (UI explanation). §2.3 fields removed → Tasks 2 (schema), 3 (API), 4/5 (web). §2.4 immutable runs → no task touches committed runs. §3 journal precondition → Task 1. §7 testing table → embedded per task.

**Placeholder scan:** all steps carry code or name the exact file/pattern to copy; Task 5 is deliberately behavioral (the design agent owns markup per its charter) with the i18n copy and write-semantics pinned here.

**Type consistency:** `PayRate`/`MissingRate` defined once in Task 2, consumed by name in Tasks 3–5; `PayRateDto` mirrors it in Task 4 with the same four fields; route paths `/api/pay-rates` consistent across Tasks 3–6; journal result `{applied, skipped, errors}` consistent between Task 1 and Task 6's expectation.

**Known risks, stated:** (1) Tasks 2+3 leave a cross-package red window — the controller reviews them as one range or dispatches back-to-back. (2) The journal's adoption probe keys on `public.levels` existing — correct for this app's 0001; revisit only if 0001 is ever rewritten. (3) NUMERIC(6,5) percent means max precision 0.00001 — five decimal places of a fraction, i.e. 0.001% granularity; fine for the business.
