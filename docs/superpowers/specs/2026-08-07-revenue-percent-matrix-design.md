# Revenue Percent Matrix — Design

**Date:** 2026-08-07
**Status:** Approved decisions from Yevhenii; spec written for the plan.

## 1. Problem

The revenue share an employee earns is currently modeled as a single per-employee
fraction (`employees.revenue_percent`, 0..1), applied identically wherever they work.
That model is wrong: **the percent actually depends on the employee's level AND the
location worked** — the same person legitimately earns a different revenue fraction at
different locations, and two employees of the same level at the same location earn the
same fraction.

## 2. Decisions (user-approved 2026-08-07)

1. **Model: a level × location matrix.** Each `(level, location)` pair carries its own
   percent. No per-level base with a location modifier — a full table of rates.
2. **The per-employee field is replaced entirely.** It was a wrong model. It disappears
   from the API and UI. (The DB column is retained but orphaned — see §6 — because
   dropping a column the deployed Lambda still selects would break the deploy window.)
3. **Missing cell = 0%.** A shift worked at a `(level, location)` with no matrix row
   contributes zero revenue share. *Consequence, accepted:* a forgotten cell silently
   pays no revenue share for that combination. The salary-run preview shows per-employee
   share figures, so a surprising `0.00` is visible there, but nothing blocks the run.
4. **Built now, in parallel** with the Schedule Authoring Stage 1 tasks (7–9). No file
   overlap with those tasks except `apps/web/src/lib/queries.ts`/`i18n.ts` (append-only
   in both tracks) and the Setup route — serialize only those edits.

## 3. Data model

New table (migration `0008_revenue_percent_matrix.sql`):

```sql
CREATE TABLE revenue_percents (
  level_id    UUID NOT NULL REFERENCES levels(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  percent     NUMERIC(6,5) NOT NULL CHECK (percent >= 0 AND percent <= 1),
  PRIMARY KEY (level_id, location_id)
);
```

- `percent` keeps the existing 0..1 fraction convention (`employees.revenue_percent`
  is `z.number().min(0).max(1)` today); the UI renders it as a percentage.
- No `TEXT` enums involved; TEXT+CHECK rule not applicable, but the migration must be
  regenerated into `migrations.generated.ts` and given a named export + test row, per
  project convention.

**Seeding.** The deployed system has real per-employee percents. The migration seeds
the matrix from them: for each `(level, location)`, if **every active employee of that
level has the same `revenue_percent`**, insert that value for **all** locations (the old
model was location-independent, so agreement per level means the level's rate was
uniform). If employees of a level disagree, seed **nothing** for that level — the admin
resolves it in the grid. Seeding is plain SQL inside the migration (one INSERT ... SELECT
with a HAVING COUNT(DISTINCT revenue_percent) = 1 group), so PGlite tests and the live
Data API run identical logic.

## 4. Calculation change

`packages/core/src/calculateSalaries.ts`:

- `CalcInput` gains `revenuePercents: { levelId: string; locationId: string; percent: number }[]`.
- `Employee.revenuePercent` is removed from `CalcInput`'s employee shape.
- Pass 2 resolves the fraction **per shift**:
  `percentByCell.get(`${employee.levelId}|${shift.locationId}`) ?? 0`.
  This mirrors how the day rate already resolves against the shift's own location.
- Tests: same-person-two-locations-two-percents; missing cell contributes 0 while a
  present cell on the same day still pays; existing proration tests updated to feed the
  matrix instead of per-employee percents.

`packages/api/src/routes/salaryRuns.ts` loads the matrix instead of reading
`employees.revenue_percent` (line ~113). Committed runs are immutable snapshots and are
not recomputed — history is unaffected.

## 5. API

New route `packages/api/src/routes/revenuePercents.ts`:

- `GET /api/revenue-percents` — manager/admin; returns all cells
  `{ levelId, locationId, percent }[]` (sparse — only configured cells).
- `PUT /api/revenue-percents` — **admin only**; body
  `{ levelId, locationId, percent }` (0..1, zod-validated); upsert
  (`ON CONFLICT (level_id, location_id) DO UPDATE`).
- `DELETE /api/revenue-percents?levelId=&locationId=` — admin only; removes a cell
  (falls back to 0%). 400 on missing params.

`employees` routes: `revenuePercent` removed from the create/patch zod schemas and from
the DTO. The API stops accepting and stops returning it.

## 6. Deploy-order constraint

The deployed Lambda selects `employees.revenue_percent`. Order:
1. Migration 0008 ships (table + seed) — additive, old code unaffected.
2. New code deploys reading the matrix.
3. The column is **not dropped** in this change. A later cleanup migration may drop it
   once no deployed code references it.

## 7. UI

**Setup screen, new admin-only panel: "Відсоток від виручки"** — the matrix grid.
- Levels as rows, locations as columns, one mono numeric input per cell (Form
  archetype; label-above rules apply to the surrounding form, cells are a table).
- Values entered as percentages (e.g. `3` → stored `0.03`); blank cell = not configured,
  rendered as an empty input with a muted `0%` hint, per decision §2.3.
- Each cell PUTs on blur/commit; a cleared cell DELETEs.
- The employee card's revenue-percent field is removed (`EmployeesRoute.tsx`).
- Hooks: `useRevenuePercents()`, `useSetRevenuePercent()`, `useClearRevenuePercent()`
  in `queries.ts`; copy in `i18n.ts` (group `revenueMatrix`).
- Implemented by the `design-developer` agent per `docs/design/system.md`.

## 8. Testing

- Core: matrix resolution unit tests (§4).
- API: route auth (employee 403), upsert semantics, DELETE, zod bounds (`>1` → 400);
  salary-run integration test where one employee works two locations with different
  cell values and the line's `revenueShare` reflects both.
- Migration seed: PGlite test — seed employees with agreeing and disagreeing level
  percents, run 0008, assert the agreeing level got cells for every location and the
  disagreeing one got none.
- Web: hook contract tests in `queries.test.tsx` (same pattern as day-off hooks);
  grid component test (typing 3 in a cell PUTs 0.03).

## 9. Out of scope

- Blocking or warning on missing cells (decision §2.3 chose 0%).
- Per-employee overrides (decision §2.2 chose full replacement).
- Dropping the orphaned `employees.revenue_percent` column (later cleanup).
- Historical run recomputation (runs are immutable snapshots by design).
