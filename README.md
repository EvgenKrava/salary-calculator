# Salary Calculator

Internal payroll automation for a single Ukrainian coffee-shop chain, deployed to AWS.
It turns scheduled shifts plus daily per-location revenue into a per-employee pay
breakdown, twice a month. All UI copy is Ukrainian. This is a single-business
application — there is no multi-tenant isolation anywhere in the design.

## 1. Who uses it

Three roles, backed by three Cognito groups:

| Role | Does |
|---|---|
| **Admin** | One-time setup: locations and their working hours, shift slots, levels (day rates), user accounts. |
| **Manager** | Daily operations: enters revenue, builds/approves the schedule, imports the workbook, reviews AI extractions, runs payroll. |
| **Employee** | Self-service, read-only-ish: views own confirmed shifts, submits shift requests, views own pay breakdown. |

A manager account also holds the `admin` and/or `manager` Cognito groups as assigned;
routes check `requireRole(...)` against the groups on the verified JWT.

## 2. How pay is calculated

This is the part that has to be exactly right, so it is documented from the actual
implementation: `packages/core/src/calculateSalaries.ts`.

**Pay periods are fixed and calendar-based:** the 1st–15th and the 16th–end of month
(`payPeriodsForMonth` in `packages/core/src/payPeriod.ts`). A salary run always
targets one of these two halves of one month.

For each **active** employee, over their **approved** shifts falling inside the
period:

```
hours(shift)        = endsAt - startsAt, in decimal hours (same-day only; no overnight shifts)

base pay            = Σ over the employee's shifts:
                        level.rate_per_day × hours(shift) / working_hours(shift.location)

revenue_share       = Σ over the employee's shifts:
                        employee.revenue_percent × approved_revenue(location, date)
                        × hours(shift) / total_hours_worked(location, date)

bonus               = manual amount entered per employee at run time (non-negative)

total               = round2(base pay) + round2(revenue_share) + round2(bonus)
```

Where:
- `working_hours(location)` is that location's own `closes_at − opens_at`. **Levels carry
  a day rate, not an hourly rate** (`levels.rate_per_day`) — this is how the business
  actually talks about pay ("ставка за день"). A full day at a location pays exactly the
  day rate; a half-day pays half. The divisor is the shift's *own* location's working day,
  because two locations with different opening hours must not pay the same rate for the
  same fraction of a shift.
- `total_hours_worked(location, date)` is the sum of `hours(shift)` over **all** approved
  shifts at that location on that date, across every employee — this is the proration
  denominator for revenue share. If one person works the whole day, they get their full
  revenue percent of that day's revenue; if two split it evenly, each gets half of their own
  percent.
- Revenue only counts if the `(location, date)` has an approved `daily_revenue` row. A
  worked location-day with **no** approved revenue is recorded as a **gap**, and any run
  containing gaps is `blocked` — it can still be previewed but not committed, so revenue
  share is never silently understated.
- Rounding to 2 decimals (`round2`) happens per component (base, share, bonus) before
  summing, using a half-away-from-zero correction for floating-point edge cases (see
  `packages/core/src/money.ts`).
- An employee may work more than one shift, and more than one location, on the same day —
  this is common in practice (a day is often split between two people) and is handled by
  proration, not forbidden.
- **A run is a one-shot, immutable snapshot.** The manager enters bonuses, runs the
  calculation, and the result (`salary_runs` + `salary_run_lines`) is saved permanently and
  immediately visible to the affected employee. There is no draft/finalize step, and later
  changes to shifts or revenue do not alter an already-committed run.

`POST /api/salary-runs/preview` computes the same figures with nothing persisted, so a
manager can see exactly what a run will produce (including gaps) before committing.
`POST /api/salary-runs` performs the same computation and either persists it (201) or
refuses with 409 and the list of gaps if the period is blocked.

## 3. Architecture

Monorepo, pnpm workspaces (`packages/*`, `apps/*`):

| Package | Role |
|---|---|
| `packages/core` | Pure, dependency-light domain logic: the salary formula, pay-period math, time/money helpers, the `.xlsx` schedule parser, SQL migration loading. No AWS SDK, no HTTP. Consumed by both `api` and `extraction`. |
| `packages/api` | The HTTP API: a Hono app (`src/app.ts`) wrapping all routes, Cognito JWT auth, Drizzle-ORM schema/queries against Postgres via the RDS Data API, S3 upload presigning. Bundled into one Lambda. |
| `packages/extraction` | The async AI-extraction Lambda: receives S3 upload events, calls Bedrock (Claude) via the Anthropic SDK, writes `extraction_jobs` rows. |
| `apps/web` | The SPA: React + TanStack Router + TanStack Query, Cognito auth via `amazon-cognito-identity-js`. Built and hosted on S3 + CloudFront. |

Deployed shape (Terraform, `infra/`):

- **Frontend:** S3 bucket (private) served through **CloudFront** with an Origin Access
  Control; SPA routing handled by mapping 403/404 back to `index.html`.
- **API:** **API Gateway (HTTP API)** in front of a **single Node/TypeScript Lambda**
  running the Hono router internally, protected by a Cognito JWT authorizer. CORS
  preflight (`OPTIONS`) is answered before the auth middleware runs, or every non-GET
  call from the browser fails with an opaque `NetworkError`.
- **Database:** **Aurora Serverless v2 Postgres**, accessed exclusively through the
  **RDS Data API** — no Lambda is VPC-attached, so there is no NAT gateway (a real cost
  driver this design avoids). `db_min_acu = 0` lets the cluster pause to zero when idle.
- **Async extraction:** an S3 `ObjectCreated:*` event on the documents bucket (prefix
  `uploads/`) triggers the extraction Lambda, which calls Bedrock via
  `AnthropicBedrockMantle` (`@anthropic-ai/bedrock-sdk`), model `anthropic.claude-opus-5`,
  with vision input and a structured-output JSON schema. High-confidence results are
  staged as approved; low-confidence ones go to a `needs_review` queue that a manager
  clears in the Review screen. Every invocation writes an `extraction_jobs` row, including
  failures and refusals — nothing is silently dropped. Contract between the Terraform
  stack and the Lambda code is pinned in `docs/contracts/extraction-lambda.md`.
- **Auth:** one Cognito user pool, three groups (`admin`, `manager`, `employee`).
  Employees are linked to their Cognito `sub` on the `employees` row. There is no public
  sign-up; the first admin is created via the CLI, every subsequent account is invited
  from the Employees screen.
- **Storage:** two S3 buckets — frontend assets, and uploaded documents (revenue photos,
  scanned schedules) with versioning enabled so a disputed extraction can be checked
  against the original scan.
- **Cross-account billing split:** the app runs in one AWS account; Bedrock/Claude calls
  are billed to a *different* account via a bearer token, so Claude usage never appears
  on the app account's bill. See `infra/cost.md`.

### Where schedule data comes from

Three paths converge on the same `shifts` table (the salary calculation only ever reads
`status = 'approved'`):

1. **Native / manual authoring** — a manager builds or edits the schedule directly
   (`DayEditor`, one day at a time; a full month grid editor is designed but not yet
   built — see §7).
2. **Spreadsheet import** (`source = 'imported'`) — a manager uploads the client's
   `.xlsx` workbook; `packages/core/src/scheduleParser.ts` parses it structurally (no AI
   involved), the manager maps spreadsheet names to employee records once
   (`schedule_name_map`), picks which month to commit, and reviews before it writes
   shifts.
3. **Photo/PDF extraction** (`source = 'extracted'`) — hand-written schedules or revenue
   sheets go through the AI extraction pipeline described above, then manager review.

## 4. Local development

Requirements: Node 20 (pinned in `.nvmrc`), pnpm 9.

```bash
pnpm install
```

Per-workspace scripts, runnable from the root across all packages or scoped with
`--filter`:

```bash
pnpm test                              # pnpm -r test — every package's vitest suite
pnpm typecheck                         # pnpm -r typecheck — tsc --noEmit everywhere
pnpm --filter @salary/api test         # one package only
pnpm --filter @salary/web dev          # Vite dev server for the SPA
```

`apps/web` also needs a local `.env` (see `apps/web/.env.example`) pointing at a
deployed API/Cognito pool — there is no local mock backend for the SPA.

**Tests never touch a real database.** `packages/core` and `packages/api` both run
migrations against an in-process **PGlite** Postgres (`@electric-sql/pglite`) — see
`packages/api/src/db/testDb.ts`, which applies every migration from
`@salary/core/migrations` to a fresh in-memory instance per test run. This is fast and
fully isolated, but it is *not* the RDS Data API, and it has bitten this project before
(§6).

## 5. Deployment

Terraform lives in `infra/`, split into a one-time `bootstrap/` stack (encrypted,
versioned S3 state bucket) and the main stack. Full detail, including cost controls and
exact commands, is in `infra/README.md` and `infra/cost.md` — summarized here.

```bash
# One-time: bootstrap remote state
cd infra/bootstrap
terraform init
terraform apply -var="project_name=salary-calculator" -var="region=us-east-1"

# Main stack
cd ..
terraform init -backend-config="bucket=<state-bucket-from-bootstrap-output>"
./deploy.sh plan     # wraps terraform, injects the Bedrock bearer token from env
./deploy.sh apply
```

Building and shipping the app after infrastructure exists:

```bash
./infra/build/build.sh                 # regenerates migrations, bundles the API + extraction Lambdas
./infra/deploy.sh apply
aws lambda invoke --function-name "$(terraform output -raw migrate_function_name)" /dev/stdout   # one-time schema creation, NOT idempotent
aws s3 sync apps/web/dist "s3://$(terraform output -raw frontend_bucket)/" --delete
aws cloudfront create-invalidation --distribution-id "$(terraform output -raw cloudfront_distribution_id)" --paths '/*'
```

All identifiers (API URL, Cognito pool ID, bucket names, CloudFront distribution ID)
come from `terraform output` — nothing is hardcoded, and none of it is reproduced here.

**Bedrock is billed to a separate AWS account** from the one the app deploys to; the
extraction Lambda authenticates with a bearer token (`AWS_BEARER_TOKEN_BEDROCK`) scoped
to a principal in that other account, so no IAM role/trust wiring is needed and Claude
usage doesn't appear on the app account's invoice.

**Cost target: well under $1/month at idle**, mainly because Aurora Serverless v2 is
configured with `db_min_acu = 0` (scale-to-zero, ~15s cold resume) and there is
deliberately no NAT gateway — Lambdas reach Postgres purely through the RDS Data API.
Setting `db_min_acu` to `0.5` alone would cost roughly $44/month sitting idle. See
`infra/cost.md` for the full breakdown and the pre-apply checks.

## 6. Project conventions

These are not stylistic preferences — each one exists because violating it previously
broke production while every test stayed green.

**a. Migrations use `TEXT + CHECK`, never a Postgres `ENUM`.**
The RDS Data API sends parameters as untyped text and Postgres will not implicitly
coerce text to an enum column — every insert against an enum column failed in
production with `column "source" is of type revenue_source but expression is of type
text`. PGlite (what every test runs against) *does* coerce implicitly, so the entire
suite passed while writing a shift, a revenue row, or an extraction job was impossible
against the real database. See `packages/core/db/migrations/0005_enum_to_text.sql` for
the full account and the ten write sites it fixed. Every status/kind/source column added
since is `TEXT NOT NULL CHECK (col IN (...))`, and the CHECK list must be kept in sync
with `packages/api/src/schema.ts`'s `pgEnum` declarations (used for query typing only,
never for the actual column type) — `packages/api/test/schema.test.ts` asserts a
rejected value for each.

**b. Every time value reaching a Postgres `TIME` column goes through `toSqlTime()`.**
The RDS Data API rejects the short `HH:MM` form for a `TIME` column
(`Parse Error for Time: premature end of input`) and requires `HH:MM:SS`. PGlite accepts
the short form, so this also only fails in production. `packages/core/src/time.ts`'s
`toSqlTime()` widens `HH:MM` → `HH:MM:SS` (idempotently); the API contract itself stays
`HH:MM` in both directions, and routes slice the stored value back down on the way out.

**c. `DATE` columns are calendar dates with no timezone — never touch them with
`new Date(iso)`.**
`work_date`, `revenue_date`, `period_start/end` must be built and compared as UTC, or
built by splitting the `YYYY-MM-DD` string directly. `new Date('2026-05-05')` parses as
UTC midnight and renders in local time, which in any negative UTC offset shows the
*previous* day — a silent off-by-one on a pay-period boundary or a revenue ledger. See
`apps/web/src/lib/dates.ts` (`isoOf`, using `Date.UTC` + `getUTC*` exclusively) and
`apps/web/src/lib/i18n.ts`'s `formatDate` (splits the string, never constructs a `Date`).
Contrast with `formatTimestampDate`, for genuine `timestamptz` columns like `created_at`,
where converting to local time *is* correct.

**d. All UI copy lives in `apps/web/src/lib/i18n.ts`.**
Nothing is inlined in components. Ukrainian plurals take **three CLDR forms**, not two —
`plural(n, one, few, many)` (e.g. `1 день / 2 дні / 5 днів`), not an
`n === 1 ? a : b` check, which is wrong for most counts. Money is deliberately **not**
run through `Intl.NumberFormat('uk-UA', …)` — that produces a narrow no-break space
thousands separator and a trailing currency sign, and a payroll figure needs to be
copy-pasteable into a spreadsheet as `1234.50`.

**e. Migrations are inlined into a committed generated file — regenerate after editing SQL.**
Each Lambda ships as one self-contained `.js`; nothing is read from disk at runtime, so
`packages/core/db/migrations/*.sql` cannot be read directly in production. Editing SQL
means running:
```bash
pnpm --filter @salary/core generate:migrations
```
which rewrites `packages/core/src/migrations.generated.ts` (committed to git).
`packages/core/test/migrations.test.ts` fails on drift between the `.sql` files and the
generated module. `infra/build/build.sh` also regenerates it as a build step, so a
forgotten regeneration leaves the tree dirty before `terraform apply`, which is the
intended signal.

## 7. Current state

**Working end to end:**
- Admin setup: levels, locations (with working hours), per-location shift slots.
- Employee/manager schedule flows: employee shift requests, manager approve/reject,
  manager day-by-day manual shift authoring (`DayEditor`), the read-only month calendar.
- `.xlsx` schedule import with persisted name-to-employee mapping, year-rollover
  handling, and a preview step before commit.
- Revenue entry (manual) and photo/PDF extraction for both revenue and schedules, with a
  manager review queue for low-confidence extractions.
- Salary run preview and commit, with the blocking-gap rule enforced; employee
  self-service pay view (`/api/salary-runs/me`).
- Full Terraform deploy path (bootstrap → main stack → build → migrate → smoke test),
  with a documented cost model and a budget alarm.

**Known incomplete, as of the newest design doc
(`docs/superpowers/specs/2026-08-07-schedule-authoring-design.md`, "Schedule
Authoring"):**
- The `shifts.status` value `'draft'`, plus the `day_off_requests`, `schedule_publications`,
  and `app_settings` tables, exist in the schema (migration `0006`) and are wired into the
  Drizzle schema, but **no API routes and no UI use them yet** — there is no publish
  endpoint, no day-off picker, and no month-grid editor (`/schedule/edit` from the design
  doc is not implemented; only the read-only `/schedule` calendar and the single-day
  `DayEditor` exist). The one piece of that design that *is* shipped is the
  `/api/shifts/me` draft/rejected status-filter fix and its dedicated
  `draft-isolation.test.ts` regression suite.
- The workbook import still writes shifts with `source = 'imported'` directly (subject to
  the normal overlap check) rather than as `draft` rows behind a diff review, as the newer
  design calls for — that is "Stage 2" in the design doc and hasn't started.
- Delete UI gaps flagged in the design's own audit (§9 of that doc) are still open:
  no delete UI for daily revenue or name mappings, and no hard-delete for salary runs.

**Found while writing this README, worth flagging:**
- `packages/core`'s own test suite currently fails one test on a clean checkout:
  `test/migrations.test.ts` — `exposes every migration in filename order` — because
  `packages/core/src/migrations.ts` only re-exports and asserts on the first five
  migrations (`INIT_SQL` … `ENUM_TO_TEXT_SQL`); it was never updated for
  `0006_schedule_authoring.sql`, even though the generated file and the migration runner
  (`MIGRATIONS`, driven off `MIGRATION_NAMES`) both correctly include it. `pnpm --filter
  @salary/api test` and `pnpm --filter @salary/web test` pass in full; this is scoped to
  the one core test file. `pnpm -r typecheck` passes everywhere.
