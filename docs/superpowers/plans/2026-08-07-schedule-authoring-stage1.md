# Schedule Authoring Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app the place a schedule is created — a people × days grid writing `draft` shifts, day-off preferences that warn the manager while building, and a publish step that turns a draft month live.

**Architecture:** `shifts.status` gains `draft`; drafts are ordinary rows that no payroll query counts and no employee sees. Three new tables carry preferences (`day_off_requests`), standing limits (`app_settings`) and publication state (`schedule_publications`). The grid is one `<table>` per shift slot with keyboard cell entry; each edit is its own request.

**Tech Stack:** pnpm workspace monorepo (`packages/core`, `packages/api`, `apps/web`); TypeScript strict ESM; Hono in-Lambda router; Drizzle ORM; Zod; PGlite in tests, RDS Data API in production; React 18 + TanStack Router/Query; vitest.

Spec: `docs/superpowers/specs/2026-08-07-schedule-authoring-design.md`

## Global Constraints

- **Migrations are TEXT + CHECK, never Postgres enums.** The RDS Data API sends parameters as untyped text and Postgres will not implicitly coerce text to an enum. PGlite *does* coerce, so an enum passes every test and fails in production. See `packages/core/db/migrations/0005_enum_to_text.sql`.
- **A `pgEnum` in `packages/api/src/schema.ts` is for query building only.** Its value list must stay in step with the migration's CHECK list.
- **Times reaching a Postgres TIME column go through `toSqlTime()`** (`packages/core/src/time.ts`). The Data API rejects `'09:00'`; it needs `'09:00:00'`.
- **`DATE` columns are calendar dates.** Build and compare them as UTC via `apps/web/src/lib/dates.ts` (`isoOf`, `todayIso`, `isoDaysAgo`, `isoRange`). Never `new Date('2026-05-05')` for a DATE — it renders as the 4th west of UTC.
- **After editing any `.sql` under `packages/core/db/migrations/`, run `pnpm --filter @salary/core generate:migrations`.** Migrations are bundled into the committed `packages/core/src/migrations.generated.ts`; nothing is read from disk at runtime.
- **All UI copy is Ukrainian and lives in `apps/web/src/lib/i18n.ts`.** Never inline a user-visible string in a component. Counts use `plural(n, one, few, many)` — Ukrainian has three forms.
- **Never commit `docs/*.xlsx`** (real staff names) and never print a staff name in test output.
- **Commit messages carry no `Co-Authored-By` and no "Generated with" footer.**

Commands, from the repo root:

| Purpose | Command |
|---|---|
| One test file | `pnpm --filter @salary/api test test/<name>.test.ts` |
| One package | `pnpm --filter @salary/api test` |
| Everything | `pnpm -r test` |
| Typecheck | `pnpm -r typecheck` |
| Regenerate migrations | `pnpm --filter @salary/core generate:migrations` |

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `packages/core/db/migrations/0006_schedule_authoring.sql` | `draft` status; `day_off_requests`, `schedule_publications`, `app_settings` tables |
| `packages/api/src/routes/dayOffRequests.ts` | CRUD for day-off requests, limit enforcement |
| `packages/api/src/routes/schedulePublications.ts` | publish a month; read publication state |
| `packages/api/src/routes/appSettings.ts` | read/write the standing limits |
| `packages/core/src/dayOffLimits.ts` | pure limit counting + conflict classification |
| `apps/web/src/routes/ScheduleGrid.tsx` | the people × days grid |
| `apps/web/src/routes/scheduleGrid.css` | grid styling, sticky first column |
| `apps/web/src/routes/DaysOffRoute.tsx` | employee cabinet picker |
| `apps/web/src/routes/DayOffPicker.tsx` | month picker shared by cabinet and admin card |
| `apps/web/src/routes/dayOffPicker.css` | picker styling |
| `apps/web/src/routes/PublishPanel.tsx` | publish gate with the conflict list |
| `packages/api/test/draft-isolation.test.ts` | the §8 guarantees |
| `packages/api/test/day-off-requests.test.ts` | limits, roles, both write paths |
| `packages/api/test/schedule-publish.test.ts` | publish, gate, idempotency |
| `packages/core/test/dayOffLimits.test.ts` | pure limit logic |
| `apps/web/test/schedule-grid.test.tsx` | grid rendering and cell edits |
| `apps/web/test/day-off-picker.test.tsx` | cycling, limits, read-only when published |

**Modify**

| File | Change |
|---|---|
| `packages/api/src/schema.ts` | add `draft` to `shiftStatus`; add the three new tables |
| `packages/api/src/routes/shifts.ts:140` | add the missing status filter to `/me` |
| `packages/api/src/routes/shifts.ts:98` | exclude `draft` from the overlap check |
| `packages/api/src/routes/salaryRuns.ts:95` | already `approved`-only — add a regression test only |
| `packages/api/src/routes/scheduleImports.ts:165` | exclude `draft` from the import overlap check |
| `packages/api/src/app.ts` | mount the three new route groups |
| `apps/web/src/lib/queries.ts` | queries/mutations for grid, day-off, publish, settings |
| `apps/web/src/router.tsx` | routes `/schedule/edit`, `/me/days-off` |
| `apps/web/src/shell/AppShell.tsx` | rail links for both |
| `apps/web/src/lib/i18n.ts` | all new copy |
| `apps/web/src/routes/SetupRoute.tsx` | the limits panel |
| `apps/web/src/routes/EmployeesRoute.tsx` | admin day-off entry on the employee card |

---

## Task 1: Migration and schema

**Files:**
- Create: `packages/core/db/migrations/0006_schedule_authoring.sql`
- Modify: `packages/api/src/schema.ts`
- Modify: `packages/core/src/migrations.generated.ts` (generated — do not hand-edit)
- Test: `packages/api/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `dayOffRequests`, `schedulePublications`, `appSettings` Drizzle tables; `shiftStatus` including `'draft'`. Column names as written in the SQL below.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/test/schema.test.ts`:

```ts
describe('schedule authoring tables', () => {
  it('accepts a draft shift and rejects an unknown status', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [loc] = await db.insert(locations).values({ name: '1', opensAt: '08:00', closesAt: '20:00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { shifts } = await import('../src/schema');

    const [row] = await db
      .insert(shifts)
      .values({
        employeeId: emp.id,
        locationId: loc.id,
        workDate: '2026-09-01',
        startsAt: '08:00:00',
        endsAt: '14:00:00',
        status: 'draft',
      })
      .returning();
    expect(row.status).toBe('draft');

    // The CHECK list in the migration must stay in step with the pgEnum in schema.ts.
    await expect(
      db.insert(shifts).values({
        employeeId: emp.id,
        locationId: loc.id,
        workDate: '2026-09-02',
        startsAt: '08:00:00',
        endsAt: '14:00:00',
        status: 'nonsense' as never,
      }),
    ).rejects.toThrow();
  });

  it('stores a day-off request and forbids two kinds on one date', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { dayOffRequests } = await import('../src/schema');

    await db.insert(dayOffRequests).values({
      employeeId: emp.id,
      requestDate: '2026-09-05',
      kind: 'required',
      createdBy: 'sub-1',
    });
    await expect(
      db.insert(dayOffRequests).values({
        employeeId: emp.id,
        requestDate: '2026-09-05',
        kind: 'preferred',
        createdBy: 'sub-1',
      }),
    ).rejects.toThrow();
  });

  it('rejects a day-off kind outside the CHECK list', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { dayOffRequests } = await import('../src/schema');
    await expect(
      db.insert(dayOffRequests).values({
        employeeId: emp.id,
        requestDate: '2026-09-06',
        kind: 'maybe' as never,
        createdBy: 'sub-1',
      }),
    ).rejects.toThrow();
  });

  it('ships exactly one settings row, and refuses a second', async () => {
    const { db } = await createTestDb();
    const { appSettings } = await import('../src/schema');
    const rows = await db.select().from(appSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0].requiredDaysOffPerMonth).toBe(2);
    expect(rows[0].preferredDaysOffPerMonth).toBe(4);
    // The single-row idiom must be enforced by the schema, not by convention.
    await expect(db.insert(appSettings).values({ id: true })).rejects.toThrow();
  });

  it('records a publication once per month', async () => {
    const { db } = await createTestDb();
    const { schedulePublications } = await import('../src/schema');
    await db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-1' });
    await expect(
      db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-2' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/api test test/schema.test.ts`
Expected: FAIL — `dayOffRequests` is not an export of `../src/schema`.

- [ ] **Step 3: Write the migration**

Create `packages/core/db/migrations/0006_schedule_authoring.sql`:

```sql
-- Schedule authoring: draft shifts, day-off preferences, publication state, standing limits.
-- Design: docs/superpowers/specs/2026-08-07-schedule-authoring-design.md
--
-- Every new status/kind column is TEXT + CHECK, never a Postgres enum: the RDS Data API sends
-- parameters as untyped text and Postgres will not implicitly coerce text to an enum, while
-- PGlite does — so an enum passes every test and makes production writes impossible. See
-- 0005_enum_to_text.sql for the ten write sites that failure mode cost us.

-- A draft shift is an ordinary row that no payroll query counts and no employee sees. Publishing
-- a month flips its drafts to 'approved'.
ALTER TABLE shifts DROP CONSTRAINT shifts_status_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_status_check
  CHECK (status IN ('draft', 'requested', 'approved', 'rejected'));

-- Preferred days off. `kind` is named rather than boolean so 'required' (blocks publishing) and
-- 'preferred' (warns only) are explicit, and a third kind is a migration rather than a rethink.
CREATE TABLE day_off_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES employees (id),
  request_date DATE NOT NULL,
  kind         TEXT NOT NULL,
  -- Cognito sub of whoever recorded it: the employee in their cabinet, or the admin on their
  -- card. "Who marked this?" must have an answer when a manager asks.
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A day is required, preferred, or neither — never two at once.
  UNIQUE (employee_id, request_date),
  CONSTRAINT day_off_requests_kind_check CHECK (kind IN ('required', 'preferred'))
);

CREATE INDEX day_off_requests_date_idx ON day_off_requests (request_date);

-- Which months are live. Needed because both the employee picker (closes on publish) and the
-- publish step itself must answer "is this month published?", and deriving it from "any approved
-- shift exists" would let a single hand-entered mid-month shift lock staff out of choosing days
-- off for an otherwise-unbuilt month.
CREATE TABLE schedule_publications (
  year            INT  NOT NULL,
  month           INT  NOT NULL,
  published_by    TEXT NOT NULL,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when publishing proceeded over a required-day-off conflict; NULL otherwise.
  override_reason TEXT,
  PRIMARY KEY (year, month),
  CONSTRAINT schedule_publications_year_check  CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT schedule_publications_month_check CHECK (month BETWEEN 1 AND 12)
);

-- Standing configuration: set once, applies to every month until changed. One limit for all
-- staff, so a new employee has a limit with no extra step.
--
-- `id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)` makes a second row impossible at the schema
-- level. Plain BOOLEAN columns already round-trip through the Data API (employees.active,
-- schedule_name_map.ignored), but a boolean PRIMARY KEY is unusual enough that Task 8 verifies
-- it against the deployed Data API, not only PGlite. Fallback if it misbehaves:
-- `id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`.
CREATE TABLE app_settings (
  id                           BOOLEAN PRIMARY KEY DEFAULT TRUE,
  required_days_off_per_month  INT NOT NULL DEFAULT 2,
  preferred_days_off_per_month INT NOT NULL DEFAULT 4,
  CONSTRAINT app_settings_single_row CHECK (id),
  CONSTRAINT app_settings_required_non_negative  CHECK (required_days_off_per_month  >= 0),
  CONSTRAINT app_settings_preferred_non_negative CHECK (preferred_days_off_per_month >= 0)
);

INSERT INTO app_settings (id) VALUES (TRUE);
```

- [ ] **Step 4: Regenerate the bundled migrations**

Run: `pnpm --filter @salary/core generate:migrations`
Expected: `packages/core/src/migrations.generated.ts` now lists `0006_schedule_authoring.sql`.

Verify: `grep -c 0006 packages/core/src/migrations.generated.ts` → at least `1`.

- [ ] **Step 5: Extend the Drizzle schema**

In `packages/api/src/schema.ts`, change the status enum (query-building only; the DB enforces the CHECK):

```ts
export const shiftStatus = pgEnum('shift_status', ['draft', 'requested', 'approved', 'rejected']);
```

Add near the other tables:

```ts
/**
 * A day an employee asked to have off.
 *
 * `required` blocks publishing until the manager confirms; `preferred` only warns. Recorded by
 * the employee in their cabinet or by an admin on their card — hence `createdBy`.
 */
export const dayOffRequests = pgTable(
  'day_off_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    requestDate: date('request_date').notNull(),
    kind: text('kind').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ oneKindPerDay: unique().on(t.employeeId, t.requestDate) }),
);

/** Months whose schedule is live. A row here closes the employee day-off picker for that month. */
export const schedulePublications = pgTable(
  'schedule_publications',
  {
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    publishedBy: text('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    overrideReason: text('override_reason'),
  },
  (t) => ({ oneRowPerMonth: primaryKey({ columns: [t.year, t.month] }) }),
);

/** Single-row standing configuration. */
export const appSettings = pgTable('app_settings', {
  id: boolean('id').primaryKey().default(true),
  requiredDaysOffPerMonth: integer('required_days_off_per_month').notNull().default(2),
  preferredDaysOffPerMonth: integer('preferred_days_off_per_month').notNull().default(4),
});
```

Add `primaryKey` to the `drizzle-orm/pg-core` import list.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @salary/api test test/schema.test.ts`
Expected: PASS, all five new cases.

If "ships exactly one settings row" fails because PGlite accepts a second row, switch the migration to `id INT PRIMARY KEY DEFAULT 1` with `CHECK (id = 1)` and update the Drizzle column to `integer('id').primaryKey().default(1)`.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm -r typecheck`
Expected: no output beyond the per-package banners.

```bash
git add packages/core/db/migrations/0006_schedule_authoring.sql \
        packages/core/src/migrations.generated.ts \
        packages/api/src/schema.ts packages/api/test/schema.test.ts
git commit -m "Add draft shift status, day-off requests, publications and settings tables"
```

---

## Task 2: Draft isolation

Fixes the live bug that `/api/shifts/me` has no status filter, and proves a draft cannot reach payroll.

**Files:**
- Modify: `packages/api/src/routes/shifts.ts` (the `/me` handler ~line 138; the overlap check ~line 98)
- Modify: `packages/api/src/routes/scheduleImports.ts` (the overlap check ~line 165)
- Test: `packages/api/test/draft-isolation.test.ts`

**Interfaces:**
- Consumes: `shiftStatus` including `'draft'` (Task 1).
- Produces: the guarantee that only `approved` shifts are visible to employees and countable by payroll. No new exports.

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/draft-isolation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dailyRevenue } from '../src/schema';
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
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '600.00' }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ name: '1', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  const [emp] = await db
    .insert(employees)
    .values({ name: 'Олена', levelId: level.id, cognitoSub: EMPLOYEE_SUB, revenuePercent: '0.0500' })
    .returning();
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

  it('every employee-facing and payroll shifts query filters on status', async () => {
    /*
     * A source-level assertion, because it is the only kind that can catch the NEXT query
     * someone adds without a filter — the actual failure mode, which no runtime test can see
     * because the query does not exist yet.
     *
     * Scoped to the two query shapes where a missing filter LEAKS or MISPAYS, rather than to
     * every `.from(shifts)`. A blanket rule flags four call sites today and only one is a bug:
     * the idempotency lookup, the manager list (whose status filter is optional by design) and
     * the fetch-by-id in `/:id/approve` are all correct without one. A test that fails on
     * correct code gets deleted by the next person, taking the real guard with it.
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/api test test/draft-isolation.test.ts`
Expected: FAIL — the `/me` cases return the draft and the rejected shift; the source scan lists `shifts.ts`.

- [ ] **Step 3: Filter `/api/shifts/me`**

In `packages/api/src/routes/shifts.ts`, replace the `/me` handler body:

```ts
  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    /*
     * `approved` only. This had NO status filter, so it served an employee their `rejected`
     * shifts as if they were real — and a `draft` shift is a schedule the manager is still
     * building, which nobody should be planning their week around.
     */
    const rows = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.employeeId, employee.id), eq(shifts.status, 'approved')));
    return c.json(rows.map(toDto));
  });
```

- [ ] **Step 4: Keep the overlap checks off drafts**

Both overlap checks already read `eq(shifts.status, 'approved')` — `packages/api/src/routes/shifts.ts:98` and `packages/api/src/routes/scheduleImports.ts:165`. Confirm, and add a comment at each so the intent survives the next edit:

```ts
          // 'approved' only: a draft is a schedule still being built and must not report a
          // phantom conflict against a real shift.
          eq(shifts.status, 'approved'),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @salary/api test test/draft-isolation.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 6: Run the whole API suite**

Run: `pnpm --filter @salary/api test`
Expected: PASS. If a `/me` test elsewhere asserted a non-approved shift was visible, it encoded the bug — update it and note why in the test.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/shifts.ts packages/api/src/routes/scheduleImports.ts \
        packages/api/test/draft-isolation.test.ts
git commit -m "Isolate draft shifts from payroll and fix the missing /shifts/me status filter"
```

---

## Task 3: Day-off limit logic (pure)

**Files:**
- Create: `packages/core/src/dayOffLimits.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/dayOffLimits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DayOffKind = 'required' | 'preferred'`
  - `interface DayOffRequestLike { requestDate: string; kind: DayOffKind }`
  - `interface DayOffLimits { required: number; preferred: number }`
  - `countInMonth(requests: DayOffRequestLike[], year: number, month: number): DayOffLimits`
  - `canAdd(existing: DayOffRequestLike[], date: string, kind: DayOffKind, limits: DayOffLimits): { ok: true } | { ok: false; reason: 'limit_reached'; kind: DayOffKind; limit: number }`
  - `interface ShiftLike { employeeId: string; workDate: string }`
  - `classifyConflicts(shifts: ShiftLike[], requestsByEmployee: Map<string, DayOffRequestLike[]>): { required: ShiftLike[]; preferred: ShiftLike[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/dayOffLimits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canAdd, classifyConflicts, countInMonth } from '../src/dayOffLimits';

const LIMITS = { required: 2, preferred: 4 };

describe('countInMonth', () => {
  it('counts each kind within the given month only', () => {
    const requests = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-20', kind: 'preferred' as const },
      { requestDate: '2026-10-01', kind: 'required' as const }, // different month
    ];
    expect(countInMonth(requests, 2026, 9)).toEqual({ required: 1, preferred: 1 });
  });

  it('does not confuse the same month in different years', () => {
    const requests = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2027-09-01', kind: 'required' as const },
    ];
    expect(countInMonth(requests, 2027, 9)).toEqual({ required: 1, preferred: 0 });
  });

  it('returns zeroes for a month with nothing in it', () => {
    expect(countInMonth([], 2026, 9)).toEqual({ required: 0, preferred: 0 });
  });
});

describe('canAdd', () => {
  it('allows a request under the limit', () => {
    expect(canAdd([], '2026-09-05', 'required', LIMITS)).toEqual({ ok: true });
  });

  it('refuses one past the limit, naming which limit and its value', () => {
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-09-03', 'required', LIMITS)).toEqual({
      ok: false,
      reason: 'limit_reached',
      kind: 'required',
      limit: 2,
    });
  });

  it('counts the two kinds separately', () => {
    // Required is full; preferred still has room.
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-09-03', 'preferred', LIMITS)).toEqual({ ok: true });
  });

  it('scopes the limit to the month of the date being added', () => {
    // September is full, October is empty — an October request must be allowed.
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-10-01', 'required', LIMITS)).toEqual({ ok: true });
  });

  it('treats a zero limit as "none allowed" rather than unlimited', () => {
    expect(canAdd([], '2026-09-01', 'required', { required: 0, preferred: 4 })).toEqual({
      ok: false,
      reason: 'limit_reached',
      kind: 'required',
      limit: 0,
    });
  });
});

describe('classifyConflicts', () => {
  it('splits shifts by the kind of day-off they land on', () => {
    const shifts = [
      { employeeId: 'e1', workDate: '2026-09-05' }, // required
      { employeeId: 'e1', workDate: '2026-09-06' }, // preferred
      { employeeId: 'e1', workDate: '2026-09-07' }, // no request
      { employeeId: 'e2', workDate: '2026-09-05' }, // e2 has no requests at all
    ];
    const byEmployee = new Map([
      [
        'e1',
        [
          { requestDate: '2026-09-05', kind: 'required' as const },
          { requestDate: '2026-09-06', kind: 'preferred' as const },
        ],
      ],
    ]);
    const out = classifyConflicts(shifts, byEmployee);
    expect(out.required).toEqual([{ employeeId: 'e1', workDate: '2026-09-05' }]);
    expect(out.preferred).toEqual([{ employeeId: 'e1', workDate: '2026-09-06' }]);
  });

  it('reports nothing when no shift lands on a requested day', () => {
    const out = classifyConflicts([{ employeeId: 'e1', workDate: '2026-09-09' }], new Map());
    expect(out).toEqual({ required: [], preferred: [] });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/core test test/dayOffLimits.test.ts`
Expected: FAIL — cannot resolve `../src/dayOffLimits`.

- [ ] **Step 3: Implement**

Create `packages/core/src/dayOffLimits.ts`:

```ts
/**
 * Day-off request limits and schedule conflicts. Pure — no database, no clock.
 *
 * Kept out of the route handlers because these are the rules a manager and an employee both
 * experience and the ones most worth testing directly: an off-by-one in the monthly count either
 * refuses a legitimate request or lets someone book the whole month off.
 */

export type DayOffKind = 'required' | 'preferred';

export interface DayOffRequestLike {
  /** 'YYYY-MM-DD' */
  requestDate: string;
  kind: DayOffKind;
}

export interface DayOffLimits {
  required: number;
  preferred: number;
}

/**
 * Month of an ISO date, compared as a string prefix.
 *
 * String comparison rather than `new Date(iso)`: a DATE column carries no timezone, and
 * constructing a Date parses it as UTC midnight which renders as the previous day anywhere west
 * of UTC — a request for the 1st would be counted against the previous month.
 */
function monthPrefix(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** How many requests of each kind fall in the given calendar month. */
export function countInMonth(
  requests: DayOffRequestLike[],
  year: number,
  month: number,
): DayOffLimits {
  const prefix = monthPrefix(year, month);
  let required = 0;
  let preferred = 0;
  for (const r of requests) {
    if (!r.requestDate.startsWith(prefix)) continue;
    if (r.kind === 'required') required += 1;
    else preferred += 1;
  }
  return { required, preferred };
}

/**
 * Whether one more request of `kind` fits within the limits for the month `date` falls in.
 *
 * Enforced on write, not at publish time: the person choosing should get the feedback, rather
 * than the manager discovering it weeks later while building the schedule.
 */
export function canAdd(
  existing: DayOffRequestLike[],
  date: string,
  kind: DayOffKind,
  limits: DayOffLimits,
): { ok: true } | { ok: false; reason: 'limit_reached'; kind: DayOffKind; limit: number } {
  const [yearText, monthText] = date.split('-');
  const counts = countInMonth(existing, Number(yearText), Number(monthText));
  const limit = kind === 'required' ? limits.required : limits.preferred;
  // >= because `counts` excludes the request being added.
  if (counts[kind] >= limit) return { ok: false, reason: 'limit_reached', kind, limit };
  return { ok: true };
}

export interface ShiftLike {
  employeeId: string;
  workDate: string;
}

/**
 * Split shifts by whether they land on a day the employee asked off.
 *
 * `required` conflicts block publishing until the manager confirms with a reason; `preferred`
 * ones only warn. Both are returned so the publish screen can state them separately — a manager
 * who cannot tell the two apart will treat every warning as noise.
 */
export function classifyConflicts(
  shifts: ShiftLike[],
  requestsByEmployee: Map<string, DayOffRequestLike[]>,
): { required: ShiftLike[]; preferred: ShiftLike[] } {
  const required: ShiftLike[] = [];
  const preferred: ShiftLike[] = [];
  for (const shift of shifts) {
    const requests = requestsByEmployee.get(shift.employeeId);
    if (!requests) continue;
    const match = requests.find((r) => r.requestDate === shift.workDate);
    if (!match) continue;
    if (match.kind === 'required') required.push(shift);
    else preferred.push(shift);
  }
  return { required, preferred };
}
```

- [ ] **Step 4: Export from the package entry point**

Add to `packages/core/src/index.ts`:

```ts
export {
  canAdd,
  classifyConflicts,
  countInMonth,
  type DayOffKind,
  type DayOffLimits,
  type DayOffRequestLike,
  type ShiftLike,
} from './dayOffLimits';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @salary/core test test/dayOffLimits.test.ts`
Expected: PASS, all 11 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dayOffLimits.ts packages/core/src/index.ts \
        packages/core/test/dayOffLimits.test.ts
git commit -m "Add pure day-off limit counting and schedule conflict classification"
```

---

## Task 4: Day-off request API

**Files:**
- Create: `packages/api/src/routes/dayOffRequests.ts`
- Create: `packages/api/src/routes/appSettings.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/day-off-requests.test.ts`

**Interfaces:**
- Consumes: `dayOffRequests`, `appSettings`, `schedulePublications` (Task 1); `canAdd`, `countInMonth` (Task 3).
- Produces:
  - `createDayOffRoutes(db: Db): Hono<AppEnv>` mounted at `/api/day-off-requests`
    - `GET /?employeeId=&year=&month=` → `{ employeeId, requestDate, kind }[]`. Manager/admin see anyone; an employee is forced to their own.
    - `PUT /` body `{ employeeId?, requestDate, kind }` → 201. An employee omits `employeeId`.
    - `DELETE /?employeeId=&date=` → `{ deleted: true }`
  - `createAppSettingsRoutes(db: Db): Hono<AppEnv>` mounted at `/api/settings`
    - `GET /` → `{ requiredDaysOffPerMonth, preferredDaysOffPerMonth }` (manager/admin)
    - `PATCH /` body either field → the updated row (admin only)

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/day-off-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, employees, appSettings, schedulePublications } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const OLENA_SUB = 'sub-olena';

const verifier: TokenVerifier = {
  async verify(token: string) {
    if (token === 'admin') return { sub: 'sub-admin', email: 'a@x', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'sub-mgr', email: 'm@x', groups: ['manager'] };
    return { sub: OLENA_SUB, email: 'o@x', groups: ['employee'] };
  },
};

const ADMIN = { Authorization: 'Bearer admin', 'content-type': 'application/json' };
const MGR = { Authorization: 'Bearer mgr', 'content-type': 'application/json' };
const EMP = { Authorization: 'Bearer emp', 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '600.00' }).returning();
  const [olena] = await db
    .insert(employees)
    .values({ name: 'Олена', levelId: level.id, cognitoSub: OLENA_SUB })
    .returning();
  const [ihor] = await db.insert(employees).values({ name: 'Ігор', levelId: level.id }).returning();
  return { db, app: createApp({ db, verifier }), olena, ihor };
}

describe('day-off requests', () => {
  it('lets an employee record their own day off without naming themselves', async () => {
    const { app, olena } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { employeeId: string; kind: string };
    expect(body.employeeId).toBe(olena.id);
    expect(body.kind).toBe('required');
  });

  it('forbids an employee recording a day off for someone else', async () => {
    const { app, ihor } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: EMP,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin record a day off on an employee card', async () => {
    // The second write path: staff with no login yet, or who tell the manager verbally.
    const { app, ihor } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'preferred' }),
    });
    expect(res.status).toBe(201);
  });

  it('records who entered the request', async () => {
    const { db, app, ihor } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'preferred' }),
    });
    const { dayOffRequests } = await import('../src/schema');
    const rows = await db.select().from(dayOffRequests);
    expect(rows[0].createdBy).toBe('sub-admin');
  });

  it('refuses a request past the configured limit, naming the limit', async () => {
    const { db, app } = await seed();
    await db.update(appSettings).set({ requiredDaysOffPerMonth: 1 });
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-01', kind: 'required' }),
    });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-02', kind: 'required' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('1');
  });

  it('changes the kind on a date already requested rather than erroring', async () => {
    // The picker cycles none → preferred → required → none; the middle step is an upsert.
    const { app } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'preferred' }),
    });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { kind: string }).kind).toBe('required');
  });

  it('refuses to change a month whose schedule is already published', async () => {
    const { db, app } = await seed();
    await db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-mgr' });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(409);
  });

  it('deletes a request', async () => {
    const { app, olena } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    const res = await app.request(
      `/api/day-off-requests?employeeId=${olena.id}&date=2026-09-05`,
      { method: 'DELETE', headers: EMP },
    );
    expect(res.status).toBe(200);
  });

  it('scopes an employee GET to their own requests even if they ask for another id', async () => {
    const { db, app, ihor, olena } = await seed();
    const { dayOffRequests } = await import('../src/schema');
    await db.insert(dayOffRequests).values([
      { employeeId: olena.id, requestDate: '2026-09-01', kind: 'required', createdBy: OLENA_SUB },
      { employeeId: ihor.id, requestDate: '2026-09-02', kind: 'required', createdBy: 'sub-admin' },
    ]);
    const res = await app.request(`/api/day-off-requests?employeeId=${ihor.id}&year=2026&month=9`, {
      headers: EMP,
    });
    const body = (await res.json()) as { employeeId: string }[];
    expect(body.every((r) => r.employeeId === olena.id)).toBe(true);
  });

  it('lets a manager read everyone for a month', async () => {
    const { db, app, ihor, olena } = await seed();
    const { dayOffRequests } = await import('../src/schema');
    await db.insert(dayOffRequests).values([
      { employeeId: olena.id, requestDate: '2026-09-01', kind: 'required', createdBy: OLENA_SUB },
      { employeeId: ihor.id, requestDate: '2026-09-02', kind: 'preferred', createdBy: 'sub-admin' },
    ]);
    const res = await app.request('/api/day-off-requests?year=2026&month=9', { headers: MGR });
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });
});

describe('app settings', () => {
  it('serves the standing limits', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', { headers: MGR });
    expect(await res.json()).toEqual({ requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 });
  });

  it('lets an admin change a limit', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: ADMIN,
      body: JSON.stringify({ requiredDaysOffPerMonth: 3 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { requiredDaysOffPerMonth: number }).requiredDaysOffPerMonth).toBe(3);
  });

  it('forbids a manager changing the limits', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: MGR,
      body: JSON.stringify({ requiredDaysOffPerMonth: 3 }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a negative limit', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: ADMIN,
      body: JSON.stringify({ requiredDaysOffPerMonth: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/api test test/day-off-requests.test.ts`
Expected: FAIL — every request 404s; the routes are not mounted.

- [ ] **Step 3: Implement the settings routes**

Create `packages/api/src/routes/appSettings.ts`:

```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { appSettings } from '../schema';

/**
 * Standing configuration — one row, set once, applies until changed.
 *
 * Readable by managers because the schedule grid shows each person's remaining allowance;
 * writable by admins only, because a limit change alters what the whole chain may request.
 */
const patchSchema = z
  .object({
    requiredDaysOffPerMonth: z.number().int().min(0).optional(),
    preferredDaysOffPerMonth: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

type SettingsRow = typeof appSettings.$inferSelect;
function toDto(row: SettingsRow) {
  return {
    requiredDaysOffPerMonth: row.requiredDaysOffPerMonth,
    preferredDaysOffPerMonth: row.preferredDaysOffPerMonth,
  };
}

/** Read the single settings row, which the migration guarantees exists. */
export async function loadSettings(db: Db): Promise<SettingsRow> {
  const [row] = await db.select().from(appSettings);
  if (!row) throw new HTTPException(500, { message: 'app settings row is missing' });
  return row;
}

export function createAppSettingsRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', requireRole('manager', 'admin'), async (c) => c.json(toDto(await loadSettings(db))));

  routes.patch('/', requireRole('admin'), async (c) => {
    const body = await readJson(c, patchSchema);
    const [row] = await db.update(appSettings).set(body).returning();
    return c.json(toDto(row));
  });

  return routes;
}
```

- [ ] **Step 4: Implement the day-off routes**

Create `packages/api/src/routes/dayOffRequests.ts`:

```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canAdd, type DayOffKind } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { currentEmployee } from '../http/employeeContext';
import { dayOffRequests, employees, schedulePublications } from '../schema';
import { loadSettings } from './appSettings';

/**
 * Days an employee asked to have off, so a manager sees the request while building the schedule
 * rather than after publishing it.
 *
 * Two write paths, deliberately: an employee records their own in their cabinet, and an admin
 * records anyone's on their card — staff with no login yet, or who tell the manager verbally.
 * That is why this is not scoped to "own records only".
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const putSchema = z.object({
  /** Omitted by an employee (they may only write their own); required for an admin. */
  employeeId: z.string().uuid().optional(),
  requestDate: dateString,
  kind: z.enum(['required', 'preferred']),
});

type RequestRow = typeof dayOffRequests.$inferSelect;
function toDto(row: RequestRow) {
  return { employeeId: row.employeeId, requestDate: row.requestDate, kind: row.kind };
}

export function createDayOffRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Which employee this call may act on.
   *
   * An employee is pinned to themselves regardless of what they send — passing someone else's id
   * is a 403 rather than a silent redirect to their own record, because silently rewriting the
   * target would make a UI bug look like it worked.
   */
  async function targetEmployeeId(c: Context<AppEnv>, requested?: string): Promise<string> {
    const principal = c.get('principal');
    const isStaff = principal.groups.some((g) => g === 'manager' || g === 'admin');
    if (isStaff) {
      if (!requested) throw new HTTPException(400, { message: 'employeeId is required' });
      const rows = await db.select().from(employees).where(eq(employees.id, requested));
      if (rows.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
      return requested;
    }
    const self = await currentEmployee(db, c);
    if (requested && requested !== self.id) {
      throw new HTTPException(403, { message: 'employees may only change their own days off' });
    }
    return self.id;
  }

  /**
   * A published month is settled: the schedule already took the preferences into account, so a
   * later change is a request to re-schedule, not a preference.
   */
  async function assertMonthOpen(date: string): Promise<void> {
    const [yearText, monthText] = date.split('-');
    const rows = await db
      .select()
      .from(schedulePublications)
      .where(
        and(
          eq(schedulePublications.year, Number(yearText)),
          eq(schedulePublications.month, Number(monthText)),
        ),
      );
    if (rows.length > 0) {
      throw new HTTPException(409, {
        message: 'the schedule for that month is already published',
      });
    }
  }

  routes.get('/', async (c) => {
    const principal = c.get('principal');
    const isStaff = principal.groups.some((g) => g === 'manager' || g === 'admin');
    // An employee always reads their own, whatever they ask for.
    const employeeId = isStaff
      ? c.req.query('employeeId')
      : (await currentEmployee(db, c)).id;

    const rows = employeeId
      ? await db.select().from(dayOffRequests).where(eq(dayOffRequests.employeeId, employeeId))
      : await db.select().from(dayOffRequests);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const filtered =
      year && month
        ? rows.filter((r) => r.requestDate.startsWith(`${year}-${String(month).padStart(2, '0')}`))
        : rows;
    return c.json(filtered.map(toDto));
  });

  routes.put('/', async (c) => {
    const body = await readJson(c, putSchema);
    const employeeId = await targetEmployeeId(c, body.employeeId);
    await assertMonthOpen(body.requestDate);

    const existing = await db
      .select()
      .from(dayOffRequests)
      .where(eq(dayOffRequests.employeeId, employeeId));

    // Changing the kind on a date already requested is an update, not a new request — so it must
    // not be counted against the limit twice. The picker cycles through kinds on one date.
    const alreadyOnThisDate = existing.find((r) => r.requestDate === body.requestDate);
    const others = existing.filter((r) => r.requestDate !== body.requestDate);

    const settings = await loadSettings(db);
    const verdict = canAdd(
      others.map((r) => ({ requestDate: r.requestDate, kind: r.kind as DayOffKind })),
      body.requestDate,
      body.kind,
      {
        required: settings.requiredDaysOffPerMonth,
        preferred: settings.preferredDaysOffPerMonth,
      },
    );
    if (!verdict.ok) {
      throw new HTTPException(409, {
        message: `limit reached: at most ${verdict.limit} ${verdict.kind} days off per month`,
      });
    }

    const createdBy = c.get('principal').sub;
    if (alreadyOnThisDate) {
      const [row] = await db
        .update(dayOffRequests)
        .set({ kind: body.kind, createdBy })
        .where(eq(dayOffRequests.id, alreadyOnThisDate.id))
        .returning();
      return c.json(toDto(row), 201);
    }
    const [row] = await db
      .insert(dayOffRequests)
      .values({ employeeId, requestDate: body.requestDate, kind: body.kind, createdBy })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.delete('/', async (c) => {
    const date = c.req.query('date');
    if (!date || !dateString.safeParse(date).success) {
      throw new HTTPException(400, { message: 'date must be YYYY-MM-DD' });
    }
    const employeeId = await targetEmployeeId(c, c.req.query('employeeId'));
    await assertMonthOpen(date);
    const [row] = await db
      .delete(dayOffRequests)
      .where(and(eq(dayOffRequests.employeeId, employeeId), eq(dayOffRequests.requestDate, date)))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'day off request not found' });
    return c.json({ deleted: true });
  });

  return routes;
}
```

Note: `targetEmployeeId` requires `employeeId` for staff, but the employee DELETE path sends its own id — which is allowed because an employee's `requested` value equals `self.id`.

- [ ] **Step 5: Mount both route groups**

In `packages/api/src/app.ts`, add the imports and mounts beside the existing ones:

```ts
import { createDayOffRoutes } from './routes/dayOffRequests';
import { createAppSettingsRoutes } from './routes/appSettings';
```

```ts
  app.route('/api/day-off-requests', createDayOffRoutes(deps.db));
  app.route('/api/settings', createAppSettingsRoutes(deps.db));
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @salary/api test test/day-off-requests.test.ts`
Expected: PASS, all 14 cases.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/dayOffRequests.ts packages/api/src/routes/appSettings.ts \
        packages/api/src/app.ts packages/api/test/day-off-requests.test.ts
git commit -m "Add day-off request and settings APIs with per-month limit enforcement"
```

---

## Task 5: Publish API

**Files:**
- Create: `packages/api/src/routes/schedulePublications.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/schedule-publish.test.ts`

**Interfaces:**
- Consumes: `schedulePublications`, `shifts`, `dayOffRequests` (Task 1); `classifyConflicts` (Task 3).
- Produces: `createSchedulePublicationRoutes(db: Db): Hono<AppEnv>` at `/api/schedule-publications`
  - `GET /?year=&month=` → `{ published: boolean, publishedAt?: string, publishedBy?: string }`
  - `POST /preview` body `{ year, month }` → `{ draftCount, conflicts: { required: […], preferred: […] } }`
  - `POST /` body `{ year, month, overrideReason? }` → `{ published: number, conflicts }`; **409** when a required conflict exists and no `overrideReason` was given.

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/schedule-publish.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dayOffRequests } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token: string) {
    if (token === 'emp') return { sub: 'sub-emp', email: 'e@x', groups: ['employee'] };
    return { sub: 'sub-mgr', email: 'm@x', groups: ['manager'] };
  },
};
const MGR = { Authorization: 'Bearer mgr', 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '600.00' }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ name: '1', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  const [emp] = await db.insert(employees).values({ name: 'Олена', levelId: level.id }).returning();
  return { db, app: createApp({ db, verifier }), loc, emp };
}

async function addDraft(db: Awaited<ReturnType<typeof seed>>['db'], empId: string, locId: string, date: string) {
  await db.insert(shifts).values({
    employeeId: empId, locationId: locId, workDate: date,
    startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft',
  });
}

describe('publishing a month', () => {
  it('turns that month\'s drafts into approved shifts', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await addDraft(db, emp.id, loc.id, '2026-09-02');
    // A different month must be left alone.
    await addDraft(db, emp.id, loc.id, '2026-10-01');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: number }).published).toBe(2);

    const rows = await db.select().from(shifts);
    const byDate = new Map(rows.map((r) => [r.workDate, r.status]));
    expect(byDate.get('2026-09-01')).toBe('approved');
    expect(byDate.get('2026-09-02')).toBe('approved');
    expect(byDate.get('2026-10-01')).toBe('draft');
  });

  it('records who published and when', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const { schedulePublications } = await import('../src/schema');
    const [row] = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, 2026), eq(schedulePublications.month, 9)));
    expect(row.publishedBy).toBe('sub-mgr');
  });

  it('blocks publishing when a shift lands on a required day off', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(409);
    // Nothing may have been published.
    const rows = await db.select().from(shifts);
    expect(rows[0].status).toBe('draft');
  });

  it('publishes over a required conflict when a reason is given', async () => {
    // Emergency cover is real; a rule that cannot be overridden gets worked around outside the
    // app, where nothing records it.
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'хвороба, немає підміни' }),
    });
    expect(res.status).toBe(200);
    const { schedulePublications } = await import('../src/schema');
    const [row] = await db.select().from(schedulePublications);
    expect(row.overrideReason).toBe('хвороба, немає підміни');
  });

  it('does not block on a preferred day off, but reports it', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-06');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-06', kind: 'preferred', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conflicts: { preferred: unknown[] } };
    expect(body.conflicts.preferred).toHaveLength(1);
  });

  it('previews conflicts without changing anything', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications/preview', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const body = (await res.json()) as { draftCount: number; conflicts: { required: unknown[] } };
    expect(body.draftCount).toBe(1);
    expect(body.conflicts.required).toHaveLength(1);
    const rows = await db.select().from(shifts);
    expect(rows[0].status).toBe('draft');
  });

  it('reports whether a month is published', async () => {
    const { db, app, loc, emp } = await seed();
    const before = await app.request('/api/schedule-publications?year=2026&month=9', { headers: MGR });
    expect(((await before.json()) as { published: boolean }).published).toBe(false);

    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const after = await app.request('/api/schedule-publications?year=2026&month=9', { headers: MGR });
    expect(((await after.json()) as { published: boolean }).published).toBe(true);
  });

  it('is idempotent: re-publishing flips new drafts and keeps the original record', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const { schedulePublications } = await import('../src/schema');
    const [first] = await db.select().from(schedulePublications);

    // A mid-month addition, then publish again.
    await addDraft(db, emp.id, loc.id, '2026-09-09');
    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: number }).published).toBe(1);

    const [again] = await db.select().from(schedulePublications);
    // The first publication is the event that mattered.
    expect(again.publishedAt.getTime()).toBe(first.publishedAt.getTime());
  });

  it('forbids an employee publishing', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-publications', {
      method: 'POST',
      headers: { Authorization: 'Bearer emp', 'content-type': 'application/json' },
      body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/api test test/schedule-publish.test.ts`
Expected: FAIL — all requests 404.

- [ ] **Step 3: Implement**

Create `packages/api/src/routes/schedulePublications.ts`:

```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { classifyConflicts, type DayOffKind, type DayOffRequestLike } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { dayOffRequests, employees, schedulePublications, shifts } from '../schema';

/**
 * Publishing turns a month's draft shifts into the live schedule.
 *
 * A required day off BLOCKS publishing until the manager confirms with a reason, rather than
 * being forbidden outright: emergency cover on someone's day off is a real situation, and a rule
 * that cannot be overridden gets worked around outside the app where nothing records it. The
 * reason is stored with the publication.
 */

const periodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  overrideReason: z.string().trim().min(1).max(500).optional(),
});

/** First and last calendar date of a month, as the DATE strings the column holds. */
function monthBounds(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export function createSchedulePublicationRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  /** Draft shifts in the month, plus how they collide with day-off requests. */
  async function assess(year: number, month: number) {
    const { from, to } = monthBounds(year, month);
    const drafts = await db
      .select()
      .from(shifts)
      .where(
        and(eq(shifts.status, 'draft'), gte(shifts.workDate, from), lte(shifts.workDate, to)),
      );

    const requests = await db.select().from(dayOffRequests);
    const byEmployee = new Map<string, DayOffRequestLike[]>();
    for (const r of requests) {
      const list = byEmployee.get(r.employeeId) ?? [];
      list.push({ requestDate: r.requestDate, kind: r.kind as DayOffKind });
      byEmployee.set(r.employeeId, list);
    }

    const conflicts = classifyConflicts(
      drafts.map((s) => ({ employeeId: s.employeeId, workDate: s.workDate })),
      byEmployee,
    );
    return { drafts, conflicts };
  }

  /** Attach names so the publish screen can say who, not just which uuid. */
  async function withNames(list: { employeeId: string; workDate: string }[]) {
    if (list.length === 0) return [];
    const emps = await db.select().from(employees);
    const nameById = new Map(emps.map((e) => [e.id, e.name]));
    return list.map((c) => ({ ...c, employeeName: nameById.get(c.employeeId) ?? '—' }));
  }

  routes.get('/', async (c) => {
    const year = Number(c.req.query('year'));
    const month = Number(c.req.query('month'));
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      throw new HTTPException(400, { message: 'year and month are required' });
    }
    const rows = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, year), eq(schedulePublications.month, month)));
    if (rows.length === 0) return c.json({ published: false });
    return c.json({
      published: true,
      publishedAt: rows[0].publishedAt,
      publishedBy: rows[0].publishedBy,
      overrideReason: rows[0].overrideReason,
    });
  });

  routes.post('/preview', async (c) => {
    const { year, month } = await readJson(c, periodSchema);
    const { drafts, conflicts } = await assess(year, month);
    return c.json({
      draftCount: drafts.length,
      conflicts: {
        required: await withNames(conflicts.required),
        preferred: await withNames(conflicts.preferred),
      },
    });
  });

  routes.post('/', async (c) => {
    const { year, month, overrideReason } = await readJson(c, periodSchema);
    const { drafts, conflicts } = await assess(year, month);

    // Required conflicts stop the publish unless the manager states a reason. Checked before any
    // write, so a refused publish changes nothing at all.
    if (conflicts.required.length > 0 && !overrideReason) {
      throw new HTTPException(409, {
        message: `${conflicts.required.length} shift(s) fall on a required day off; a reason is needed to publish anyway`,
      });
    }

    const { from, to } = monthBounds(year, month);
    const flipped = await db
      .update(shifts)
      .set({ status: 'approved' })
      .where(and(eq(shifts.status, 'draft'), gte(shifts.workDate, from), lte(shifts.workDate, to)))
      .returning();

    // Idempotent: re-publishing a month flips any new drafts but leaves the original
    // publishedBy/publishedAt intact — the first publication is the event that mattered.
    const existing = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, year), eq(schedulePublications.month, month)));
    if (existing.length === 0) {
      await db.insert(schedulePublications).values({
        year,
        month,
        publishedBy: c.get('principal').sub,
        overrideReason: overrideReason ?? null,
      });
    }

    return c.json({
      published: flipped.length,
      conflicts: {
        required: await withNames(conflicts.required),
        preferred: await withNames(conflicts.preferred),
      },
    });
  });

  return routes;
}
```

- [ ] **Step 4: Mount it**

In `packages/api/src/app.ts`:

```ts
import { createSchedulePublicationRoutes } from './routes/schedulePublications';
```

```ts
  app.route('/api/schedule-publications', createSchedulePublicationRoutes(deps.db));
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @salary/api test test/schedule-publish.test.ts`
Expected: PASS, all 9 cases.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/schedulePublications.ts packages/api/src/app.ts \
        packages/api/test/schedule-publish.test.ts
git commit -m "Add month publish API with a required-day-off gate"
```

---

## Task 6: Web queries and i18n

Pure plumbing, so the two UI tasks that follow contain only UI.

**Files:**
- Modify: `apps/web/src/lib/queries.ts`
- Modify: `apps/web/src/lib/i18n.ts`
- Test: `apps/web/test/api.test.ts` (extend)

**Interfaces:**
- Consumes: the APIs from Tasks 4 and 5.
- Produces:
  - `useDayOffRequests(params: { employeeId?: string; year: number; month: number })` → `DayOffRequest[]`
  - `useSetDayOff()` → mutate `{ employeeId?, requestDate, kind }`
  - `useClearDayOff()` → mutate `{ employeeId: string; date: string }`
  - `useAppSettings()` → `{ requiredDaysOffPerMonth, preferredDaysOffPerMonth }`
  - `useUpdateAppSettings()`
  - `usePublicationState(params: { year: number; month: number })` → `{ published: boolean; … }`
  - `usePublishPreview()` / `usePublishMonth()`
  - `interface DayOffRequest { employeeId: string; requestDate: string; kind: 'required' | 'preferred' }`
  - `interface PublishConflict { employeeId: string; employeeName: string; workDate: string }`

- [ ] **Step 1: Add the query types and hooks**

Append to `apps/web/src/lib/queries.ts`:

```ts
export interface DayOffRequest {
  employeeId: string;
  requestDate: string;
  kind: 'required' | 'preferred';
}

export interface AppSettingsDto {
  requiredDaysOffPerMonth: number;
  preferredDaysOffPerMonth: number;
}

export interface PublishConflict {
  employeeId: string;
  employeeName: string;
  workDate: string;
}

export interface PublishAssessment {
  draftCount: number;
  conflicts: { required: PublishConflict[]; preferred: PublishConflict[] };
}

/**
 * Day-off requests for a month.
 *
 * `employeeId` omitted means "everyone" for a manager and "me" for an employee — the API decides,
 * so the grid and the cabinet share one hook.
 */
export function useDayOffRequests(params: { employeeId?: string; year: number; month: number }) {
  const api = useApi();
  const qs = new URLSearchParams({ year: String(params.year), month: String(params.month) });
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return useQuery({
    queryKey: ['day-off-requests', params.employeeId ?? null, params.year, params.month],
    queryFn: () => api.get<DayOffRequest[]>(`/api/day-off-requests?${qs}`),
  });
}

export function useSetDayOff() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeId?: string; requestDate: string; kind: 'required' | 'preferred' }) =>
      api.put<DayOffRequest>('/api/day-off-requests', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['day-off-requests'] }),
  });
}

export function useClearDayOff() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, date }: { employeeId: string; date: string }) =>
      api.del<{ deleted: boolean }>(
        `/api/day-off-requests?employeeId=${employeeId}&date=${date}`,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['day-off-requests'] }),
  });
}

export function useAppSettings() {
  const api = useApi();
  return useQuery({ queryKey: ['app-settings'], queryFn: () => api.get<AppSettingsDto>('/api/settings') });
}

export function useUpdateAppSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AppSettingsDto>) => api.patch<AppSettingsDto>('/api/settings', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['app-settings'] });
      // The remaining-allowance figures in the picker derive from these limits.
      void qc.invalidateQueries({ queryKey: ['day-off-requests'] });
    },
  });
}

export function usePublicationState(params: { year: number; month: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['schedule-publication', params.year, params.month],
    queryFn: () =>
      api.get<{ published: boolean; publishedAt?: string; publishedBy?: string; overrideReason?: string }>(
        `/api/schedule-publications?year=${params.year}&month=${params.month}`,
      ),
  });
}

export function usePublishPreview() {
  const api = useApi();
  return useMutation({
    mutationFn: (body: { year: number; month: number }) =>
      api.post<PublishAssessment>('/api/schedule-publications/preview', body),
  });
}

export function usePublishMonth() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { year: number; month: number; overrideReason?: string }) =>
      api.post<{ published: number; conflicts: PublishAssessment['conflicts'] }>(
        '/api/schedule-publications',
        body,
      ),
    onSuccess: () => {
      // Publishing changes shift statuses, closes the day-off picker, and makes shifts payable.
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['schedule-publication'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}
```

- [ ] **Step 2: Add the copy**

In `apps/web/src/lib/i18n.ts`, add two groups and extend `nav` and `setup`:

```ts
  // in `nav`
    scheduleEdit: 'Скласти графік',
    myDaysOff: 'Мої вихідні',

  // new top-level group
  scheduleGrid: {
    title: 'Скласти графік',
    hint: 'Клітинка — номер локації. Зміни зберігаються одразу, але графік не видно працівникам до публікації.',
    slotTab: (n: number, from: string, to: string) => `Зміна ${n} · ${from}–${to}`,
    noSlots: 'Для локацій ще не налаштовано зміни — графік використає час роботи локації.',
    clearCell: 'Прибрати',
    shiftsPerPerson: 'Змін',
    peoplePerDay: 'Людей',
    published: 'Опубліковано',
    draftBadge: (n: number) => `${n} ${plural(n, 'чернетка', 'чернетки', 'чернеток')}`,
    conflictRequired: 'Обов\'язковий вихідний',
    conflictPreferred: 'Бажаний вихідний',
    cellLabel: (name: string, day: number) => `${name}, ${day} число`,
  },

  daysOff: {
    title: 'Бажані вихідні',
    myTitle: 'Мої бажані вихідні',
    hint: 'Натисніть на день, щоб позначити його: бажаний → обов\'язковий → без позначки.',
    required: 'Обов\'язковий',
    preferred: 'Бажаний',
    requiredShort: 'обов\'язкових',
    preferredShort: 'бажаних',
    used: (used: number, limit: number) => `${used}/${limit}`,
    monthPublished: 'Графік на цей місяць уже опубліковано — зміни закриті.',
    limitReached: (limit: number, kind: string) =>
      `Ліміт: не більше ${limit} ${kind} вихідних на місяць.`,
    // Settings panel
    limitsTitle: 'Ліміти бажаних вихідних',
    limitsHint: 'Діє для всіх працівників, доки не зміните. Не застосовується до вже опублікованих місяців.',
    requiredPerMonth: 'Обов\'язкових на місяць',
    preferredPerMonth: 'Бажаних на місяць',
  },

  publish: {
    title: (month: string) => `Опублікувати ${month}`,
    button: 'Опублікувати',
    publishing: 'Публікуємо…',
    nothingToPublish: 'Немає чернеток для публікації.',
    willPublish: (n: number) => `${n} ${plural(n, 'зміну', 'зміни', 'змін')} буде опубліковано.`,
    requiredConflicts: (n: number) =>
      `${n} ${plural(n, 'зміна', 'зміни', 'змін')} на обов'язкових вихідних`,
    preferredConflicts: (n: number) =>
      `${n} ${plural(n, 'зміна', 'зміни', 'змін')} на бажаних вихідних (не блокує)`,
    reasonLabel: 'Причина',
    reasonRequired: 'Вкажіть причину, щоб опублікувати попри обов\'язкові вихідні.',
    confirmOverride: 'Підтвердити і опублікувати',
    alreadyPublished: (date: string) => `Опубліковано ${date}`,
  },
```

- [ ] **Step 3: Extend the API-client test**

Append to `apps/web/test/api.test.ts`:

```ts
describe('day-off and publish endpoints', () => {
  it('builds a month-scoped day-off query', () => {
    const qs = new URLSearchParams({ year: '2026', month: '9' });
    qs.set('employeeId', 'e1');
    expect(`/api/day-off-requests?${qs}`).toBe(
      '/api/day-off-requests?year=2026&month=9&employeeId=e1',
    );
  });
});
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm --filter @salary/web typecheck && pnpm --filter @salary/web test`
Expected: no type errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/queries.ts apps/web/src/lib/i18n.ts apps/web/test/api.test.ts
git commit -m "Add web queries and Ukrainian copy for day-off requests and publishing"
```

---

## Task 7: Day-off picker

**Files:**
- Create: `apps/web/src/routes/DayOffPicker.tsx`
- Create: `apps/web/src/routes/dayOffPicker.css`
- Create: `apps/web/src/routes/DaysOffRoute.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx`
- Modify: `apps/web/src/routes/SetupRoute.tsx`
- Modify: `apps/web/src/routes/EmployeesRoute.tsx`
- Test: `apps/web/test/day-off-picker.test.tsx`

**Interfaces:**
- Consumes: `useDayOffRequests`, `useSetDayOff`, `useClearDayOff`, `useAppSettings`, `usePublicationState` (Task 6); `buildMonthGrid` from `apps/web/src/routes/ScheduleRoute.tsx`; `isoOf`/`todayIso` from `apps/web/src/lib/dates.ts`.
- Produces:
  - `DayOffPicker({ employeeId, year, month, onMonthChange }: { employeeId?: string; year: number; month: number; onMonthChange?: (y: number, m: number) => void })`
  - `DaysOffRoute()` — the employee cabinet screen at `/me/days-off`
  - `DayOffLimitsPanel()` — exported for `SetupRoute`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/day-off-picker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

const setDayOff = { mutateAsync: vi.fn(async (_b: unknown) => ({})), isPending: false };
const clearDayOff = { mutateAsync: vi.fn(async (_b: unknown) => ({})), isPending: false };
const requestsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const settingsQuery = {
  data: { requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 },
  isLoading: false,
  error: null as unknown,
};
const publicationQuery = { data: { published: false }, isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useDayOffRequests: () => requestsQuery,
  useSetDayOff: () => setDayOff,
  useClearDayOff: () => clearDayOff,
  useAppSettings: () => settingsQuery,
  usePublicationState: () => publicationQuery,
}));

const { DayOffPicker } = await import('../src/routes/DayOffPicker');

beforeEach(() => {
  setDayOff.mutateAsync.mockClear();
  clearDayOff.mutateAsync.mockClear();
  requestsQuery.data = [];
  publicationQuery.data = { published: false };
  settingsQuery.data = { requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 };
});

/**
 * Clicking a day cycles none → preferred → required → none, so one control expresses three
 * states without a separate mode switch.
 */
describe('DayOffPicker', () => {
  it('marks an unmarked day as preferred on first click', async () => {
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' }),
    );
  });

  it('promotes a preferred day to required on the next click', async () => {
    requestsQuery.data = [{ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' }];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ requestDate: '2026-09-05', kind: 'required' }),
    );
  });

  it('clears a required day on the third click', async () => {
    requestsQuery.data = [{ employeeId: 'e1', requestDate: '2026-09-05', kind: 'required' }];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(clearDayOff.mutateAsync).toHaveBeenCalledWith({ employeeId: 'e1', date: '2026-09-05' });
  });

  it('shows how much of each allowance is used', () => {
    requestsQuery.data = [
      { employeeId: 'e1', requestDate: '2026-09-01', kind: 'required' },
      { employeeId: 'e1', requestDate: '2026-09-02', kind: 'preferred' },
    ];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.used(1, 2))).toBeInTheDocument();
    expect(screen.getByText(t.daysOff.used(1, 4))).toBeInTheDocument();
  });

  it('goes read-only once the month is published', async () => {
    publicationQuery.data = { published: true };
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.monthPublished)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).not.toHaveBeenCalled();
  });

  it('surfaces the API limit message instead of failing silently', async () => {
    setDayOff.mutateAsync.mockRejectedValueOnce(
      new Error('limit reached: at most 2 required days off per month'),
    );
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(
      await screen.findByText('limit reached: at most 2 required days off per month'),
    ).toBeInTheDocument();
  });

  it('only counts the displayed month in the allowance', () => {
    // A request in October must not consume September's allowance.
    requestsQuery.data = [
      { employeeId: 'e1', requestDate: '2026-10-01', kind: 'required' },
    ];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.used(0, 2))).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/web test test/day-off-picker.test.tsx`
Expected: FAIL — cannot resolve `../src/routes/DayOffPicker`.

- [ ] **Step 3: Implement the picker**

Create `apps/web/src/routes/DayOffPicker.tsx`:

```tsx
import { useState } from 'react';
import { buildMonthGrid } from './ScheduleRoute';
import {
  useAppSettings,
  useClearDayOff,
  useDayOffRequests,
  usePublicationState,
  useSetDayOff,
  type DayOffRequest,
} from '../lib/queries';
import { t } from '../lib/i18n';
import './dayOffPicker.css';

/**
 * Pick the days an employee wants off, one month at a time.
 *
 * Clicking a day cycles none → bажаний → обов'язковий → none, so a single control expresses
 * three states with no mode switch — the whole interaction is "click the days you need".
 *
 * Shared by the employee cabinet and the admin's employee card, which is why `employeeId` is a
 * prop rather than implied: staff with no login yet still need their days recorded, and the API
 * accepts either write path.
 */
export function DayOffPicker({
  employeeId,
  year,
  month,
}: {
  employeeId?: string;
  year: number;
  month: number;
}) {
  const requests = useDayOffRequests({ employeeId, year, month });
  const settings = useAppSettings();
  const publication = usePublicationState({ year, month });
  const setDayOff = useSetDayOff();
  const clearDayOff = useClearDayOff();
  const [error, setError] = useState<string | null>(null);

  const published = publication.data?.published ?? false;
  const cells = buildMonthGrid(year, month);
  const byDate = new Map((requests.data ?? []).map((r) => [r.requestDate, r]));

  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const inMonth = (requests.data ?? []).filter((r) => r.requestDate.startsWith(prefix));
  const usedRequired = inMonth.filter((r) => r.kind === 'required').length;
  const usedPreferred = inMonth.filter((r) => r.kind === 'preferred').length;
  const limits = settings.data ?? { requiredDaysOffPerMonth: 0, preferredDaysOffPerMonth: 0 };

  /** none → preferred → required → none. */
  async function cycle(iso: string) {
    if (published) return;
    setError(null);
    const current = byDate.get(iso);
    try {
      if (!current) {
        await setDayOff.mutateAsync({ employeeId, requestDate: iso, kind: 'preferred' });
      } else if (current.kind === 'preferred') {
        await setDayOff.mutateAsync({ employeeId, requestDate: iso, kind: 'required' });
      } else {
        // Clearing needs an explicit id: the DELETE query string has no "me" shorthand.
        const target = employeeId ?? current.employeeId;
        await clearDayOff.mutateAsync({ employeeId: target, date: iso });
      }
    } catch (err) {
      // The API owns the limit rule, so its message is the one worth showing.
      setError((err as Error).message);
    }
  }

  function markOf(r: DayOffRequest | undefined): string {
    if (!r) return '';
    return r.kind === 'required' ? 'day-off__cell--required' : 'day-off__cell--preferred';
  }

  return (
    <div className="day-off">
      <p className="muted">{published ? t.daysOff.monthPublished : t.daysOff.hint}</p>

      <div className="day-off__grid">
        {t.schedule.weekdays.map((wd) => (
          <div key={wd} className="day-off__weekday">
            {wd}
          </div>
        ))}
        {cells.map((cell) => {
          const request = byDate.get(cell.iso);
          return (
            <button
              key={cell.iso}
              type="button"
              className={[
                'day-off__cell',
                cell.inMonth ? '' : 'day-off__cell--outside',
                markOf(request),
                published ? 'day-off__cell--locked' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void cycle(cell.iso)}
              disabled={published || !cell.inMonth}
              aria-pressed={request ? true : false}
            >
              <span className="day-off__daynum">{cell.day}</span>
              {request ? (
                <span className="day-off__mark">
                  {request.kind === 'required' ? t.daysOff.required : t.daysOff.preferred}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <dl className="day-off__counts">
        <dt>{t.daysOff.required}</dt>
        <dd className="mono">{t.daysOff.used(usedRequired, limits.requiredDaysOffPerMonth)}</dd>
        <dt>{t.daysOff.preferred}</dt>
        <dd className="mono">{t.daysOff.used(usedPreferred, limits.preferredDaysOffPerMonth)}</dd>
      </dl>

      {error ? <p className="day-off__error">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Style it**

Create `apps/web/src/routes/dayOffPicker.css`:

```css
/*
 * Month picker for day-off requests. Deliberately the same 7-column shape as the schedule
 * calendar so the two read as the same kind of object.
 */

.day-off__grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  overflow: hidden;
  max-width: 44rem;
}

.day-off__weekday {
  background: var(--surface-raised);
  color: var(--ink-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: center;
  padding: var(--s2);
}

.day-off__cell {
  appearance: none;
  border: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  background: var(--surface);
  min-height: 56px;
  padding: var(--s1) var(--s2);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
  transition: background var(--transition);
}

.day-off__cell:hover:not(:disabled) {
  background: var(--surface-sunk);
}

.day-off__cell--outside {
  background: var(--ground);
  cursor: default;
}

/* Required is --stop, preferred is --warn: the same colour language the rest of the app uses for
   "blocks" versus "look at this". */
.day-off__cell--required {
  background: var(--stop-tint);
  box-shadow: inset 3px 0 0 var(--stop);
}
.day-off__cell--preferred {
  background: var(--warn-tint);
  box-shadow: inset 3px 0 0 var(--warn);
}

.day-off__cell--locked {
  cursor: not-allowed;
}

.day-off__daynum {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--ink-muted);
}

.day-off__mark {
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}

.day-off__counts {
  display: grid;
  grid-template-columns: auto auto;
  gap: var(--s1) var(--s3);
  justify-content: start;
  align-items: baseline;
  margin: var(--s4) 0 0;
}
.day-off__counts dt {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.day-off__counts dd {
  margin: 0;
  font-weight: 500;
}

.day-off__error {
  margin: var(--s3) 0 0;
  color: var(--stop);
  font-size: var(--text-sm);
}
```

- [ ] **Step 5: Add the cabinet route and the settings panel**

Create `apps/web/src/routes/DaysOffRoute.tsx`:

```tsx
import { useState } from 'react';
import { Toolbar } from '../ui/Toolbar';
import { Card } from '../ui/Card';
import { Select } from '../ui/Select';
import { DayOffPicker } from './DayOffPicker';
import { MONTHS, t } from '../lib/i18n';

/**
 * An employee's own day-off screen.
 *
 * The horizon is the current month plus the next two. A bound rather than "any unpublished
 * month": an unlimited future invites marking December in March, which nobody will honour.
 */
export function DaysOffRoute() {
  const now = new Date();
  const options = [0, 1, 2].map((offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
  const [chosen, setChosen] = useState(`${options[0].year}-${options[0].month}`);
  const [year, month] = chosen.split('-').map(Number);

  return (
    <>
      <Toolbar title={t.daysOff.myTitle}>
        <Select label={t.schedule.month} name="period" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {options.map((o) => (
            <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
              {MONTHS[o.month - 1]} {o.year}
            </option>
          ))}
        </Select>
      </Toolbar>
      <Card>
        {/* No employeeId: the API resolves the caller to their own record. */}
        <DayOffPicker year={year} month={month} />
      </Card>
    </>
  );
}
```

Add to `apps/web/src/routes/SetupRoute.tsx` — the limits panel, and render it inside `SetupRoute` after `LevelsPanel`:

```tsx
/** Standing day-off limits. Admin-only, and they apply to every month until changed. */
export function DayOffLimitsPanel() {
  const settings = useAppSettings();
  const update = useUpdateAppSettings();
  const [required, setRequired] = useState('');
  const [preferred, setPreferred] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = settings.data;
  if (settings.isLoading || !current) return <p className="mono">{t.common.loading}</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body: { requiredDaysOffPerMonth?: number; preferredDaysOffPerMonth?: number } = {};
    if (required.trim() !== '') body.requiredDaysOffPerMonth = Number(required);
    if (preferred.trim() !== '') body.preferredDaysOffPerMonth = Number(preferred);
    if (Object.keys(body).length === 0) return;
    try {
      await update.mutateAsync(body);
      setRequired('');
      setPreferred('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="panel" style={{ padding: 'var(--s5)', marginTop: 'var(--s6)' }} onSubmit={submit}>
      <h2 style={{ marginBottom: 'var(--s2)' }}>{t.daysOff.limitsTitle}</h2>
      <p className="muted">{t.daysOff.limitsHint}</p>
      <div className="field-row">
        <Field
          label={t.daysOff.requiredPerMonth}
          name="requiredDaysOffPerMonth"
          type="number"
          min="0"
          numeric
          placeholder={String(current.requiredDaysOffPerMonth)}
          value={required}
          onChange={(e) => setRequired(e.target.value)}
        />
        <Field
          label={t.daysOff.preferredPerMonth}
          name="preferredDaysOffPerMonth"
          type="number"
          min="0"
          numeric
          placeholder={String(current.preferredDaysOffPerMonth)}
          value={preferred}
          onChange={(e) => setPreferred(e.target.value)}
        />
      </div>
      {error ? <p className="setup__rowError">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={update.isPending}>
        {update.isPending ? t.common.saving : t.common.save}
      </Button>
    </form>
  );
}
```

Add `useAppSettings, useUpdateAppSettings` to the `../lib/queries` import in `SetupRoute.tsx`.

- [ ] **Step 6: Add the admin path on the employee card**

In `apps/web/src/routes/EmployeesRoute.tsx`, add a «Вихідні» toggle to the read-only row's `row-actions` that expands a detail row containing the picker for that employee, using the same spanning-cell pattern as the slot editor:

```tsx
        {daysOffOpen ? (
          <tr className="setup__detailRow">
            <td className="td" colSpan={6}>
              <h3 className="sr-only">{t.daysOff.title}</h3>
              {/* Admin write path: staff with no login, or who tell the manager verbally. */}
              <DayOffPicker employeeId={emp.id} year={monthNow.year} month={monthNow.month} />
            </td>
          </tr>
        ) : null}
```

with `const [daysOffOpen, setDaysOffOpen] = useState(false);` in `EmployeeRow`, `const monthNow = { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 };` above the return, and `import { DayOffPicker } from './DayOffPicker';`. Add `daysOff: 'Вихідні'` to `t.employees`.

- [ ] **Step 7: Register the route and rail link**

In `apps/web/src/router.tsx`:

```ts
import { DaysOffRoute } from './routes/DaysOffRoute';
```

```ts
const myDaysOffRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/me/days-off',
  component: DaysOffRoute,
});
```

Add `myDaysOffRoute` to `appRoute.addChildren([...])`.

In `apps/web/src/shell/AppShell.tsx`, inside the employee-only group:

```tsx
              <RailLink to="/me/days-off" label={t.nav.myDaysOff} />
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @salary/web test test/day-off-picker.test.tsx`
Expected: PASS, all 7 cases.

- [ ] **Step 9: Typecheck, full suite, commit**

Run: `pnpm --filter @salary/web typecheck && pnpm --filter @salary/web test`
Expected: no type errors; all tests pass.

```bash
git add apps/web/src/routes/DayOffPicker.tsx apps/web/src/routes/dayOffPicker.css \
        apps/web/src/routes/DaysOffRoute.tsx apps/web/src/routes/SetupRoute.tsx \
        apps/web/src/routes/EmployeesRoute.tsx apps/web/src/router.tsx \
        apps/web/src/shell/AppShell.tsx apps/web/src/lib/i18n.ts \
        apps/web/test/day-off-picker.test.tsx
git commit -m "Add day-off picker for the employee cabinet, admin card and setup limits"
```

---

## Task 8: Schedule grid and publish

**Files:**
- Create: `apps/web/src/routes/ScheduleGrid.tsx`
- Create: `apps/web/src/routes/scheduleGrid.css`
- Create: `apps/web/src/routes/PublishPanel.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx`
- Test: `apps/web/test/schedule-grid.test.tsx`

**Interfaces:**
- Consumes: `useShifts`, `useAssignShift`, `useDeleteShift`, `useEmployees`, `useLocations`, `useShiftSlots` (existing); `useDayOffRequests`, `usePublicationState`, `usePublishPreview`, `usePublishMonth` (Task 6); `buildMonthGrid`, `isoOf` (existing).
- Produces: `ScheduleGrid()` at `/schedule/edit`; `PublishPanel({ year, month })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/schedule-grid.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

const assign = { mutateAsync: vi.fn(async (_b: unknown) => ({})), isPending: false };
const remove = { mutateAsync: vi.fn(async (_id: string) => ({})), isPending: false };
const shiftsQuery = { data: [] as unknown[], isLoading: false, isPending: false, error: null as unknown };
const employeesQuery = {
  data: [
    { id: 'e1', name: 'Олена', levelId: 'lv1', revenuePercent: 0.05, cognitoSub: null, active: true },
    { id: 'e2', name: 'Ігор', levelId: 'lv1', revenuePercent: 0, cognitoSub: null, active: false },
  ],
  isLoading: false, isPending: false, error: null as unknown,
};
const locationsQuery = {
  data: [{ id: 'l1', name: '1', opensAt: '08:00', closesAt: '20:00' }],
  isLoading: false, isPending: false, error: null as unknown,
};
const slotsQuery = {
  data: [{ locationId: 'l1', slotNumber: 1, startsAt: '08:00', endsAt: '14:00' }],
  isLoading: false, error: null as unknown,
};
const dayOffQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useShifts: () => shiftsQuery,
  useAssignShift: () => assign,
  useDeleteShift: () => remove,
  useEmployees: () => employeesQuery,
  useLocations: () => locationsQuery,
  useShiftSlots: () => slotsQuery,
  useDayOffRequests: () => dayOffQuery,
  usePublicationState: () => ({ data: { published: false }, isLoading: false, error: null }),
  usePublishPreview: () => ({ mutateAsync: vi.fn(async () => ({ draftCount: 0, conflicts: { required: [], preferred: [] } })), isPending: false }),
  usePublishMonth: () => ({ mutateAsync: vi.fn(async () => ({ published: 0, conflicts: { required: [], preferred: [] } })), isPending: false }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: unknown; to?: string }) => <a href={to as string}>{children as never}</a>,
}));

const { ScheduleGrid } = await import('../src/routes/ScheduleGrid');

beforeEach(() => {
  assign.mutateAsync.mockClear();
  remove.mutateAsync.mockClear();
  shiftsQuery.data = [];
  dayOffQuery.data = [];
});

describe('ScheduleGrid', () => {
  it('renders one row per active employee', () => {
    render(<ScheduleGrid />);
    expect(screen.getByText('Олена')).toBeInTheDocument();
    // An inactive employee cannot be scheduled, so they are not a row.
    expect(screen.queryByText('Ігор')).not.toBeInTheDocument();
  });

  it('assigns a draft shift when a cell is set', async () => {
    render(<ScheduleGrid />);
    const cell = screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) });
    await userEvent.click(cell);
    await userEvent.click(screen.getByRole('button', { name: /^1$/ }));

    expect(assign.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', locationId: 'l1', status: 'draft' }),
    );
  });

  it('removes the shift when a filled cell is cleared', async () => {
    const iso = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-03`;
    shiftsQuery.data = [
      { id: 's1', employeeId: 'e1', locationId: 'l1', workDate: iso, startsAt: '08:00', endsAt: '14:00', status: 'draft', source: 'native' },
    ];
    render(<ScheduleGrid />);
    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) }));
    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.clearCell }));
    expect(remove.mutateAsync).toHaveBeenCalledWith('s1');
  });

  it('marks a cell whose date the person asked off', () => {
    const iso = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-05`;
    dayOffQuery.data = [{ employeeId: 'e1', requestDate: iso, kind: 'required' }];
    render(<ScheduleGrid />);
    const cell = screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 5) });
    // The mark must show on an EMPTY cell too, so the manager sees the request before assigning.
    expect(cell.className).toContain('grid__cell--required');
  });

  it('totals shifts per person', () => {
    const y = new Date().getUTCFullYear();
    const m = String(new Date().getUTCMonth() + 1).padStart(2, '0');
    shiftsQuery.data = [
      { id: 's1', employeeId: 'e1', locationId: 'l1', workDate: `${y}-${m}-01`, startsAt: '08:00', endsAt: '14:00', status: 'draft', source: 'native' },
      { id: 's2', employeeId: 'e1', locationId: 'l1', workDate: `${y}-${m}-02`, startsAt: '08:00', endsAt: '14:00', status: 'draft', source: 'native' },
    ];
    render(<ScheduleGrid />);
    const row = screen.getByText('Олена').closest('tr')!;
    expect(row.textContent).toContain('2');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @salary/web test test/schedule-grid.test.tsx`
Expected: FAIL — cannot resolve `../src/routes/ScheduleGrid`.

- [ ] **Step 3: Implement the grid**

Create `apps/web/src/routes/ScheduleGrid.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Toolbar } from '../ui/Toolbar';
import { Button } from '../ui/Button';
import { MonthSelect } from '../ui/Select';
import { anyLoading, firstError } from '../ui/QueryGate';
import { buildMonthGrid } from './ScheduleRoute';
import { PublishPanel } from './PublishPanel';
import {
  useAssignShift,
  useDayOffRequests,
  useDeleteShift,
  useEmployees,
  useLocations,
  useShiftSlots,
  useShifts,
  type Shift,
} from '../lib/queries';
import { t } from '../lib/i18n';
import './scheduleGrid.css';

/**
 * Build a month by hand: rows are people, columns are days, a cell holds a location number.
 *
 * This is the same shape as the client's own workbook block, so the mental model transfers
 * directly — and it is the structure the xlsx import will pre-fill in Stage 2 rather than writing
 * shifts straight to the database.
 *
 * One grid per shift slot, switched by tabs, because the workbook stacks a block per slot and one
 * person may legitimately work morning at one café and evening at another. A cell therefore holds
 * exactly one location, which keeps entry to a single click.
 */
export function ScheduleGrid() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [slot, setSlot] = useState(1);
  const [openCell, setOpenCell] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cells = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const monthDays = cells.filter((c) => c.inMonth);
  const from = monthDays[0]?.iso ?? '';
  const to = monthDays[monthDays.length - 1]?.iso ?? '';

  const shifts = useShifts({ from, to });
  const employees = useEmployees();
  const locations = useLocations();
  const dayOff = useDayOffRequests({ year, month });
  const assign = useAssignShift();
  const remove = useDeleteShift();

  // Slot windows come from the first location: they are configured per location, and the grid
  // needs a window to write. A location whose slot is unset falls back to its opening hours.
  const firstLocation = locations.data?.[0];
  const slots = useShiftSlots(firstLocation?.id);

  if (anyLoading(shifts, employees, locations)) return <p className="mono">{t.common.loading}</p>;
  const loadError = firstError(shifts, employees, locations);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0 }}>{t.common.couldNotLoad(t.scheduleGrid.title.toLowerCase())}</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
      </div>
    );
  }

  const people = (employees.data ?? []).filter((e) => e.active);
  const locs = locations.data ?? [];
  const slotList = slots.data ?? [];
  const window = slotList.find((s) => s.slotNumber === slot);

  /** Shift for (person, day, slot), keyed by the window so two slots on a day stay distinct. */
  const shiftAt = (employeeId: string, iso: string): Shift | undefined =>
    (shifts.data ?? []).find(
      (s) =>
        s.employeeId === employeeId &&
        s.workDate === iso &&
        (window ? s.startsAt === window.startsAt : true),
    );

  const dayOffAt = (employeeId: string, iso: string) =>
    (dayOff.data ?? []).find((r) => r.employeeId === employeeId && r.requestDate === iso);

  async function setCell(employeeId: string, iso: string, locationId: string) {
    setError(null);
    setOpenCell(null);
    try {
      await assign.mutateAsync({
        employeeId,
        locationId,
        workDate: iso,
        startsAt: window?.startsAt,
        endsAt: window?.endsAt,
        // A draft is invisible to staff and uncounted by payroll until the month is published.
        status: 'draft',
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function clearCell(shiftId: string) {
    setError(null);
    setOpenCell(null);
    try {
      await remove.mutateAsync(shiftId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <Toolbar title={t.scheduleGrid.title} description={t.scheduleGrid.hint}>
        <MonthSelect label={t.schedule.month} value={String(month)} onChange={(v) => setMonth(Number(v))} />
        <input
          className="field__input mono"
          type="number"
          aria-label={t.schedule.year}
          style={{ maxWidth: '9ch' }}
          value={year}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n)) setYear(n);
          }}
        />
      </Toolbar>

      {slotList.length === 0 ? (
        <p className="muted">{t.scheduleGrid.noSlots}</p>
      ) : (
        <div className="grid__tabs" role="tablist">
          {slotList.map((s) => (
            <button
              key={s.slotNumber}
              type="button"
              role="tab"
              aria-selected={s.slotNumber === slot}
              className={`grid__tab${s.slotNumber === slot ? ' grid__tab--active' : ''}`}
              onClick={() => setSlot(s.slotNumber)}
            >
              {t.scheduleGrid.slotTab(s.slotNumber, s.startsAt, s.endsAt)}
            </button>
          ))}
        </div>
      )}

      <div className="grid__wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="grid__corner">{t.common.employee}</th>
              {monthDays.map((c) => (
                <th key={c.iso} className="grid__dayhead">{c.day}</th>
              ))}
              <th className="grid__total">{t.scheduleGrid.shiftsPerPerson}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const count = monthDays.filter((c) => shiftAt(person.id, c.iso)).length;
              return (
                <tr key={person.id}>
                  <th scope="row" className="grid__name">{person.name}</th>
                  {monthDays.map((c) => {
                    const shift = shiftAt(person.id, c.iso);
                    const request = dayOffAt(person.id, c.iso);
                    const cellKey = `${person.id}:${c.iso}`;
                    const locName = shift ? locs.find((l) => l.id === shift.locationId)?.name ?? '?' : '';
                    return (
                      <td key={c.iso} className="grid__cellwrap">
                        <button
                          type="button"
                          className={[
                            'grid__cell',
                            shift ? 'grid__cell--filled' : '',
                            shift?.status === 'approved' ? 'grid__cell--published' : '',
                            request?.kind === 'required' ? 'grid__cell--required' : '',
                            request?.kind === 'preferred' ? 'grid__cell--preferred' : '',
                          ].filter(Boolean).join(' ')}
                          aria-label={t.scheduleGrid.cellLabel(person.name, c.day)}
                          onClick={() => setOpenCell(openCell === cellKey ? null : cellKey)}
                        >
                          {locName || '·'}
                        </button>
                        {openCell === cellKey ? (
                          <div className="grid__popover">
                            {locs.map((l) => (
                              <button
                                key={l.id}
                                type="button"
                                className="grid__option"
                                onClick={() => void setCell(person.id, c.iso, l.id)}
                              >
                                {l.name}
                              </button>
                            ))}
                            {shift ? (
                              <button
                                type="button"
                                className="grid__option grid__option--clear"
                                onClick={() => void clearCell(shift.id)}
                              >
                                {t.scheduleGrid.clearCell}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    );
                  })}
                  <td className="grid__total mono">{count}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="grid__name">{t.scheduleGrid.peoplePerDay}</th>
              {monthDays.map((c) => (
                <td key={c.iso} className="grid__total mono">
                  {people.filter((p) => shiftAt(p.id, c.iso)).length}
                </td>
              ))}
              <td className="grid__total" />
            </tr>
          </tfoot>
        </table>
      </div>

      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}

      <PublishPanel year={year} month={month} />
    </>
  );
}
```

- [ ] **Step 4: Style the grid**

Create `apps/web/src/routes/scheduleGrid.css`:

```css
/*
 * People × days entry grid — the same shape as the client's workbook block.
 *
 * No virtualisation: 14 people × 31 days is 434 cells, well within what the browser handles, and
 * virtualising would break keyboard navigation and in-page find for no measured gain.
 */

.grid__tabs {
  display: flex;
  gap: var(--s1);
  margin-bottom: var(--s4);
  flex-wrap: wrap;
}

.grid__tab {
  appearance: none;
  font: inherit;
  font-size: var(--text-sm);
  min-height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink-muted);
  cursor: pointer;
}
.grid__tab--active {
  background: var(--amber-tint);
  border-color: var(--amber-edge);
  color: var(--ink);
  font-weight: 600;
}

/* Horizontal scroll for 31 columns; the name column stays put so a row is always identifiable. */
.grid__wrap {
  overflow-x: auto;
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.grid {
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

.grid__corner,
.grid__name {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--surface-raised);
  text-align: left;
  font-weight: 500;
  font-size: var(--text-sm);
  padding: var(--s2) var(--s3);
  min-width: 12ch;
  white-space: nowrap;
  box-shadow: inset -1px 0 0 var(--rule);
}

.grid__dayhead {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--ink-muted);
  padding: var(--s2) 0;
  min-width: 2.4rem;
  background: var(--surface-raised);
}

.grid__cellwrap {
  position: relative;
  padding: 0;
  border: 1px solid var(--rule);
}

.grid__cell {
  appearance: none;
  border: 0;
  font: inherit;
  font-family: var(--font-mono);
  width: 100%;
  min-width: 2.4rem;
  height: 34px;
  background: none;
  color: var(--ink-faint);
  cursor: pointer;
  transition: background var(--transition);
}
.grid__cell:hover {
  background: var(--surface-sunk);
}
.grid__cell--filled {
  color: var(--ink);
  font-weight: 500;
}
/* A published cell is settled; a draft is not. One tick rather than a colour, so the day-off
   colours stay unambiguous. */
.grid__cell--published {
  box-shadow: inset 2px 0 0 var(--ok);
}
.grid__cell--required {
  background: var(--stop-tint);
}
.grid__cell--preferred {
  background: var(--warn-tint);
}

.grid__popover {
  position: absolute;
  z-index: 5;
  top: 100%;
  left: 0;
  min-width: 8rem;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: var(--s1);
}

.grid__option {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  padding: var(--s2) var(--s3);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.grid__option:hover {
  background: var(--surface-sunk);
}
.grid__option--clear {
  color: var(--stop);
}

.grid__total {
  font-size: var(--text-xs);
  color: var(--ink-muted);
  text-align: center;
  padding: var(--s2);
  background: var(--surface-raised);
}
```

- [ ] **Step 5: Implement the publish panel**

Create `apps/web/src/routes/PublishPanel.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { usePublicationState, usePublishMonth, usePublishPreview, type PublishAssessment } from '../lib/queries';
import { MONTHS, t, formatDate, formatTimestampDate } from '../lib/i18n';

/**
 * Turn a month's drafts into the live schedule.
 *
 * A required day off blocks publishing until the manager gives a reason — not a hard prohibition,
 * because emergency cover on someone's day off is real and a rule that cannot be overridden gets
 * worked around outside the app where nothing records it.
 */
export function PublishPanel({ year, month }: { year: number; month: number }) {
  const state = usePublicationState({ year, month });
  const preview = usePublishPreview();
  const publish = usePublishMonth();
  const [assessment, setAssessment] = useState<PublishAssessment | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<number | null>(null);

  async function check() {
    setError(null);
    setPublished(null);
    try {
      setAssessment(await preview.mutateAsync({ year, month }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function commit() {
    setError(null);
    try {
      const result = await publish.mutateAsync({
        year,
        month,
        overrideReason: reason.trim() === '' ? undefined : reason.trim(),
      });
      setPublished(result.published);
      setAssessment(null);
      setReason('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const blocked = (assessment?.conflicts.required.length ?? 0) > 0;

  return (
    <Card title={t.publish.title(`${MONTHS[month - 1]} ${year}`)}>
      {state.data?.published ? (
        <p className="muted">
          {t.publish.alreadyPublished(formatTimestampDate(String(state.data.publishedAt)))}
        </p>
      ) : null}

      {assessment ? (
        <>
          <p>
            {assessment.draftCount === 0
              ? t.publish.nothingToPublish
              : t.publish.willPublish(assessment.draftCount)}
          </p>

          {assessment.conflicts.required.length > 0 ? (
            <div style={{ marginBottom: 'var(--s3)' }}>
              <p style={{ color: 'var(--stop)', margin: 0, fontWeight: 500 }}>
                {t.publish.requiredConflicts(assessment.conflicts.required.length)}
              </p>
              <ul className="mono" style={{ margin: 'var(--s1) 0 0', paddingLeft: 'var(--s6)', fontSize: 'var(--text-xs)' }}>
                {assessment.conflicts.required.map((c) => (
                  <li key={`${c.employeeId}-${c.workDate}`}>
                    {c.employeeName} · {formatDate(c.workDate)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {assessment.conflicts.preferred.length > 0 ? (
            <p style={{ color: 'var(--warn)' }}>
              {t.publish.preferredConflicts(assessment.conflicts.preferred.length)}
            </p>
          ) : null}

          {blocked ? (
            <Field
              label={t.publish.reasonLabel}
              name="overrideReason"
              fieldSize="wide"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint={t.publish.reasonRequired}
            />
          ) : null}

          <Button
            variant="primary"
            onClick={() => void commit()}
            disabled={publish.isPending || assessment.draftCount === 0 || (blocked && reason.trim() === '')}
          >
            {publish.isPending
              ? t.publish.publishing
              : blocked
                ? t.publish.confirmOverride
                : t.publish.button}
          </Button>
        </>
      ) : (
        <Button onClick={() => void check()} disabled={preview.isPending}>
          {t.publish.button}
        </Button>
      )}

      {published !== null ? <p style={{ color: 'var(--ok)' }}>{t.publish.willPublish(published)}</p> : null}
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
    </Card>
  );
}
```

- [ ] **Step 6: Register the route and rail link**

In `apps/web/src/router.tsx`:

```ts
import { ScheduleGrid } from './routes/ScheduleGrid';
```

```ts
const scheduleEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/schedule/edit',
  component: ScheduleGrid,
});
```

Add `scheduleEditRoute` to `appRoute.addChildren([...])`.

In `apps/web/src/shell/AppShell.tsx`, in the Операції group after the Графік link:

```tsx
                <RailLink to="/schedule/edit" label={t.nav.scheduleEdit} />
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @salary/web test test/schedule-grid.test.tsx`
Expected: PASS, all 5 cases.

- [ ] **Step 8: Full suite and typecheck**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: no type errors; every package passes.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/routes/ScheduleGrid.tsx apps/web/src/routes/scheduleGrid.css \
        apps/web/src/routes/PublishPanel.tsx apps/web/src/router.tsx \
        apps/web/src/shell/AppShell.tsx apps/web/test/schedule-grid.test.tsx
git commit -m "Add people x days schedule grid writing drafts, and the publish gate"
```

---

## Task 9: Deploy and verify against the live Data API

The one thing no test in this repo can prove: that the migration behaves the same on the RDS Data API as on PGlite. Four deploy-only failures in this project came from exactly that gap.

**Files:** none (deployment only).

- [ ] **Step 1: Build and deploy the API**

```bash
pnpm --filter @salary/api bundle
cd packages/api/dist && rm -f api.zip migrate.zip \
  && zip -q api.zip api.js && zip -q migrate.zip migrate.js
AWS_PROFILE=yevhenii aws lambda update-function-code \
  --function-name salary-calculator-api --zip-file fileb://api.zip \
  --region us-east-1 --query 'LastUpdateStatus' --output text
AWS_PROFILE=yevhenii aws lambda update-function-code \
  --function-name salary-calculator-migrate --zip-file fileb://migrate.zip \
  --region us-east-1 --query 'LastUpdateStatus' --output text
```

Expected: `InProgress` twice. Wait for `Successful` via
`AWS_PROFILE=yevhenii aws lambda get-function-configuration --function-name salary-calculator-api --region us-east-1 --query 'LastUpdateStatus' --output text`.

- [ ] **Step 2: Run the migration**

```bash
AWS_PROFILE=yevhenii aws lambda invoke --function-name salary-calculator-migrate \
  --region us-east-1 /tmp/migrate-out.json && cat /tmp/migrate-out.json
```

Expected: a success payload, no `errorMessage`. Aurora may be resuming from zero capacity — if it reports `DatabaseResumingException`, invoke again.

**If the `app_settings` boolean primary key is rejected**, apply the fallback from Task 1 Step 6: change the migration to `id INT PRIMARY KEY DEFAULT 1` with `CHECK (id = 1)` and the Drizzle column to `integer('id').primaryKey().default(1)`, regenerate, redeploy, and re-run.

- [ ] **Step 3: Verify the new tables and the settings row exist**

Get a manager token and call the settings endpoint (the URL is in `.env` as `API_URL`):

```bash
cd apps/web && cp /dev/null /tmp/tok.cjs && cat > tok.cjs <<'JS'
const {CognitoUserPool,CognitoUser,AuthenticationDetails}=require("amazon-cognito-identity-js");
const p=new CognitoUserPool({UserPoolId:process.env.VITE_COGNITO_USER_POOL_ID,ClientId:process.env.VITE_COGNITO_CLIENT_ID});
const u=new CognitoUser({Username:process.env.ADMIN_EMAIL,Pool:p});
u.authenticateUser(new AuthenticationDetails({Username:process.env.ADMIN_EMAIL,Password:process.env.ADMIN_PASSWORD}),{
 onSuccess:s=>{console.log(s.getIdToken().getJwtToken());process.exit(0)},
 onFailure:e=>{console.error("AUTH FAIL:",e.message);process.exit(1)}});
JS
set -a && . ../../.env && set +a && TOKEN=$(node tok.cjs) && rm -f tok.cjs
curl -s -H "authorization: Bearer $TOKEN" "$API_URL/api/settings"
```

Expected: `{"requiredDaysOffPerMonth":2,"preferredDaysOffPerMonth":4}`.

A 500 here means the migration did not apply or the single-row insert did not run — check the migrate Lambda's CloudWatch log before proceeding.

- [ ] **Step 4: Verify a draft round-trips through the Data API**

The Data API sends parameters as untyped text, so a new CHECK-constrained value is exactly the class of thing that passes PGlite and fails in production. Write one draft shift and read it back:

```bash
# Substitute real ids from GET /api/employees and GET /api/locations.
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"employeeId":"<EMP_ID>","locationId":"<LOC_ID>","workDate":"2026-12-01","startsAt":"08:00","endsAt":"14:00","status":"draft"}' \
  "$API_URL/api/shifts"
```

Expected: HTTP 201 with `"status":"draft"`. A 500 mentioning `invalid input value` or a type error means the CHECK/TEXT handling needs revisiting before any UI is used.

- [ ] **Step 5: Deploy the frontend**

```bash
cd apps/web && pnpm build
AWS_PROFILE=yevhenii aws s3 sync dist/ s3://salary-calculator-frontend-898836755334/ --delete
AWS_PROFILE=yevhenii aws cloudfront create-invalidation \
  --distribution-id E1YO0946X6AAD4 --paths "/*" --query 'Invalidation.Status' --output text
```

Expected: `InProgress`. Allow ~50s for the invalidation.

- [ ] **Step 6: Walk the flow in a browser**

At `https://d1j2hh24d31bhq.cloudfront.net`, signed in as admin:

1. Налаштування → set the two day-off limits; confirm they persist on reload.
2. Працівники → «Вихідні» on a row → mark two days; confirm the counters move.
3. Скласти графік → set a cell on a marked day; confirm it renders with the conflict colour.
4. Опублікувати → confirm the required conflict blocks, that a reason unblocks it, and that the cell then shows as published.
5. Sign in as an employee → «Мої зміни» shows only published shifts, never the draft.

- [ ] **Step 7: Commit any fixes and note the verification**

```bash
git add -A
git commit -m "Verify schedule authoring against the live Data API"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3.1 draft shifts | 1, 2 |
| §3.2 day_off_requests | 1, 4 |
| §3.3 schedule_publications | 1, 5 |
| §3.4 app_settings | 1, 4 |
| §4 grid authoring | 8 |
| §5 day-off picking (cabinet + admin card, 2-month horizon, write-time limits, closes on publish) | 4, 7 |
| §7 publish + required-day-off gate | 5, 8 |
| §8 draft isolation incl. the `/me` fix and the source scan | 2 |
| §11 testing | every task; pure logic in 3 |
| §6 import as draft | **Stage 2 — deliberately out of scope** |
| §9 delete coverage | **Stage 2 — deliberately out of scope** |

**Placeholders:** none. Every code step carries the code; every command carries its expected output.

**Type consistency:** `DayOffKind`, `DayOffRequestLike`, `DayOffLimits`, `ShiftLike` are defined in Task 3 and used with those names in Tasks 4, 5 and 6. `DayOffRequest`, `AppSettingsDto`, `PublishConflict`, `PublishAssessment` are defined in Task 6 and used in Tasks 7 and 8. `canAdd` returns `{ ok: true } | { ok: false; reason; kind; limit }` in Task 3 and is destructured that way in Task 4. `loadSettings` is exported from `appSettings.ts` in Task 4 Step 3 and imported by `dayOffRequests.ts` in Step 4. `Field`'s width prop is `fieldSize`, matching the existing component — not `size`, which is the native numeric input attribute.

**Known deviation:** Task 8's grid reads slot windows from the first location only. Slots are per-location, so a chain whose cafés run different windows needs a per-location slot lookup — recorded here rather than silently assumed. Stage 2 should revisit it once real slot data exists; today every deployed location carries identical placeholder hours, so the simplification is invisible.
