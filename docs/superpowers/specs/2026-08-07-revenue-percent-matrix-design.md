# Pay Matrix (day rate + revenue percent per level × location) — Design

**Date:** 2026-08-07, revised 2026-08-09
**Status:** Revision approved in chat; supersedes the revenue-percent-only v1 of this spec.

## 1. Problem

Both pay parameters are currently modeled at the wrong grain:

- **Day rate (ставка):** `levels.rate_per_day` — one rate per level, identical at every
  location. The business rule is that the same level pays a *different* day rate at
  different locations.
- **Revenue percent:** `employees.revenue_percent` — one fraction per employee, identical
  everywhere. The business rule is that the percent depends on the employee's **level AND
  the location worked**.

## 2. Decisions (user-approved)

1. **One matrix, two values.** A single `pay_rates` table keyed `(level_id, location_id)`
   carries both `rate_per_day` and `revenue_percent`. A **level becomes a pure label**
   ("Бариста", "Старший") — it no longer carries money itself.
2. **Missing cell blocks the salary run** (2026-08-09). The day rate is someone's entire
   base wage: a shift worked at an unconfigured `(level, location)` is reported like a
   missing revenue day — the preview lists the missing cells and the run cannot commit
   until an admin fills them. This *supersedes* v1's "missing percent = 0%" rule at the
   cell level: a missing **row** blocks. Within a configured row, `revenue_percent`
   defaults to 0 (a location-level pair can legitimately earn rate-only).
3. **Old fields are removed outright** (v1 decision, now cheaper): `levels.rate_per_day`
   and `employees.revenue_percent` disappear from schema, API, and UI. The user has
   accepted DB recreation (done once already on 2026-08-09); production data is empty, so
   no orphan-column deploy dance and no seeding step are needed.
4. **Committed salary runs stay immutable snapshots** — no recomputation of history.

## 3. Data model

Migration `0008_pay_matrix.sql`:

```sql
CREATE TABLE pay_rates (
  level_id        UUID NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  rate_per_day    NUMERIC(10,2) NOT NULL CHECK (rate_per_day >= 0),
  revenue_percent NUMERIC(6,5)  NOT NULL DEFAULT 0 CHECK (revenue_percent >= 0 AND revenue_percent <= 1),
  PRIMARY KEY (level_id, location_id)
);

ALTER TABLE levels    DROP COLUMN rate_per_day;
ALTER TABLE employees DROP COLUMN revenue_percent;
```

- `ON DELETE CASCADE`: a deleted level/location takes its matrix cells with it — the
  cells are configuration, not payroll history (history lives in run snapshots).
- `revenue_percent` stays a 0..1 fraction internally; the UI renders percentages.
- Regenerate `migrations.generated.ts`, add the named export, extend the migrations test
  (project convention).

### Migration-runner precondition

The migrate Lambda has **no journal table** — it re-runs from 0001 and fails loudly on an
existing schema (fine when recreating, fatal for an additive 0008 on a live DB). This
plan's Task 1 adds the journal: a `schema_migrations` table (filename PK, applied_at),
the handler skips applied entries and seeds 0001..0007 as applied when it finds the
schema already present. Deploy for THIS feature may still use drop-and-recreate (data
loss accepted while the app is pre-launch), but the journal ships now so the next
migration after 0008 doesn't hit the same wall.

## 4. Calculation change (`packages/core/src/calculateSalaries.ts`)

- `CalcInput`: `levels` loses `ratePerDay`; employees lose `revenuePercent`; new
  `payRates: { levelId; locationId; ratePerDay; revenuePercent }[]`.
- Both components resolve **per shift** from the shift's own location — mirroring how the
  location's working day already prorates the rate:
  - base: `rate = cell(employee.levelId, shift.locationId).ratePerDay`
  - share: `percent = cell(...).revenuePercent`
- **Missing cell → blocking gap.** `CalcResult` gains
  `missingRates: { levelId; locationId }[]` (deduped); any entry marks the result
  `blocked`, exactly like revenue gaps. The affected shift contributes nothing to either
  component (it will never be committed — blocked runs cannot commit).
- Tests: same person, two locations, two different rates and percents on one day;
  missing-cell shift blocks while a configured one on the same day still computes;
  percent-0 row pays rate only.

## 5. API

New route `packages/api/src/routes/payRates.ts`:

- `GET /api/pay-rates` — manager/admin; all configured cells.
- `PUT /api/pay-rates` — admin; body `{ levelId, locationId, ratePerDay, revenuePercent? }`
  (percent defaults 0); zod-validated (rate ≥ 0, percent 0..1); upsert on conflict.
- `DELETE /api/pay-rates?levelId=&locationId=` — admin; removes the cell (those shifts
  then block a run, by design). 400 on missing params.

Changed routes:
- `levels.ts`: `ratePerDay` removed from schemas and DTO.
- `employees.ts`: `revenuePercent` removed from schemas and DTO.
- `salaryRuns.ts`: loads `pay_rates` instead of the two dropped columns; the 409-with-gaps
  response gains `missingRates` alongside `gaps`.

## 6. UI

**Setup, admin-only panel "Оплата по локаціях"** — the matrix.
- Levels as rows, locations as columns; each cell holds TWO mono inputs: ставка (грн/день)
  and % виручки. Form archetype; built by the `design-developer` agent per
  `docs/design/system.md` (money column rules apply to the rate figures).
- Unconfigured cell renders visibly distinct (empty inputs + muted hint), since it now
  blocks payroll — not an error color (`--stop` is reserved for blocked runs themselves),
  but unmistakably unfilled.
- Cell PUTs on commit; clearing a cell DELETEs after an "are you sure — this blocks
  payroll for this combination" confirm.
- Levels panel loses its rate field; employee card loses its percent field.
- Runs screen: a blocked preview lists missing (level, location) pairs by NAME as links
  to Setup — same pattern as missing revenue days.
- Hooks `usePayRates` / `useSetPayRate` / `useClearPayRate`; i18n group `payMatrix`;
  contract tests in `queries.test.tsx`.

## 7. Testing

- Core: resolution per shift, blocking semantics, percent-0 row (§4).
- API: role gating (employee 403, manager read-only), upsert, delete, zod bounds; a
  salary-run integration test with two locations/two rates for one person; run commit
  409s listing `missingRates` when a cell is missing.
- Migration: journal table skips applied entries (Task 1's own tests); 0008 applies on a
  fresh PGlite; migrations test extended for the new named export.
- Web: matrix grid writes both values with correct units (UI "3" → stored 0.03 for
  percent; rate stored as entered); blocked-run screen names missing cells.

## 8. Out of scope

- Per-employee overrides of either value (level × location fully determines both).
- Rate/percent history or effective-dating — a cell edit changes future runs only;
  committed snapshots already preserve the past.
- Migrating v1's `revenue_percents` table: it never shipped (spec superseded pre-plan).
