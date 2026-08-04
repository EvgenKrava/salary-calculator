# Salary Calculator — Design

**Date:** 2026-08-03
**Status:** Approved (design), pending implementation plan

## 1. Scope & purpose

Automate the twice-monthly salary calculation for a **single business with multiple
locations**. The core value is turning scheduled shifts plus daily per-location revenue
into a correct per-employee pay breakdown. Hand-written source documents (daily revenue
reports and schedules) are digitized via AI, with human approval when extraction quality
is low.

This is a **single-business** application (no multi-tenant isolation).

## 2. Roles (Cognito groups)

Three roles, backed by three Cognito groups:

- **Admin** — setup: locations (and their standard shift length), levels (and hourly
  rate), user accounts.
- **Manager** — operations: manage employees, upload and approve documents, approve
  shift requests, run the salary calculation.
- **Employee** — self-service, read-only: view own confirmed shifts, submit shift
  requests, view own pay breakdown.

## 3. Salary calculation (core formula)

Pay periods are fixed: **1st–15th** and **16th–end of month**.

For a pay period, for each active employee **E**:

```
hours(shift)   = shift.ends_at − shift.starts_at        (in hours)

hourly_pay     = Σ over E's confirmed shifts in period:
                   E.level.rate_per_hour × hours(shift)

revenue_share  = Σ over E's confirmed shifts in period:
                   E.revenue_percent × daily_revenue(shift.location, shift.date)
                   × hours(shift) / total_hours(shift.location, shift.date)

personal_bonus = manual amount entered per employee at run time

total          = hourly_pay + revenue_share + personal_bonus
```

where `total_hours(location, date)` is the sum of `hours(shift)` over **all** confirmed
shifts at that location on that date.

Key rules:

- **Hourly pay uses actual hours.** Every shift records explicit `starts_at`/`ends_at`
  times; hours worked is their difference. A day can be split between people (one works
  part of it, another finishes) — a real and common case in this business.
- **Revenue share is attributed by shift and prorated by hours.** An employee earns their
  percent of a location-day's revenue scaled by their share of the hours worked at that
  location that day. If one person works the whole day, they get their full percent; if two
  split it evenly, each gets half of their own percent. Proration is by hours worked, not
  by headcount.
- **Each location has its own working hours** (`opens_at`/`closes_at`), which provide the
  default shift times when a schedule source supplies none.
- **One-shot run.** The manager enters personal bonuses, runs the calculation, and the
  result is saved as the final immutable record — immediately visible to the affected
  employee. There is no separate draft/finalize step.
- **Blocker rule.** If any worked `(location, date)` has no approved daily revenue figure,
  the run flags those gaps and will not finalize until they are resolved, so revenue share
  is never silently understated.

## 4. Data model (Aurora Serverless v2 Postgres)

- **levels** (id, name, rate_per_hour)
- **locations** (id, name, opens_at, closes_at) — each location has its own working hours,
  used as the default shift window
- **location_shift_slots** (id, location_id, slot_number, starts_at, ends_at) — the window
  for each shift slot at a location; unique per (location_id, slot_number). Used by the
  spreadsheet importer to turn a slot block into concrete shift times (§5.1)
- **schedule_name_map** (id, source_name, employee_id nullable, ignored) — persisted mapping
  from a spreadsheet name-row to an employee record; `ignored` marks rows that are not
  people (e.g. `Бариста 1`). Unique per source_name (§5.1)
- **employees** (id, name, level_id, revenue_percent, cognito_sub nullable, active)
- **shifts** (id, employee_id, location_id, work_date, starts_at, ends_at,
  status: `requested` | `approved` | `rejected`,
  source: `native` | `extracted` | `imported`) — unique per
  (employee, work_date, location, starts_at); an employee may work more than one shift or
  location in a day
- **daily_revenue** (id, location_id, revenue_date, amount,
  source: `manual` | `extracted`, status)
- **extraction_jobs** (id, doc_type: `revenue` | `schedule`, s3_key,
  status: `processing` | `needs_review` | `approved` | `rejected`,
  confidence, extracted_json, reviewed_by)
- **salary_runs** (id, period_start, period_end, created_by, created_at)
- **salary_run_lines** (id, run_id, employee_id, hourly_pay, revenue_share, bonus, total)
  — a snapshot of the computed breakdown at run time

Assumptions:

- An employee **may work more than one shift and more than one location per day** (days are
  split between people in practice).
- The `salary_run_lines` snapshot preserves the computed values even if inputs change
  later.

## 5. Scheduling (three input paths → one confirmed schedule)

All paths converge on the same `shifts` table; the calculation only reads
`status = approved`.

- **Native scheduling:** an employee submits a shift request (location + date) → the
  manager approves or rejects it → approved shifts form the confirmed schedule.
- **Spreadsheet import (`imported`):** the business currently keeps the schedule in an
  Excel workbook (`Графік роботи Coffee Shop.xlsx`). A manager uploads the `.xlsx`; the app
  **parses** it (structured data — no AI vision needed) and presents the parsed shifts for
  manager review before they are committed. See §5.1 for the layout and rules.

### 5.1 Spreadsheet schedule layout and import rules

Verified against the real workbook, sheet `Графік роботи`:

- **Months run horizontally.** `Травень` (May) occupies day columns 4–34, `Червень` (June)
  starts at column 37, and so on. A header row carries weekday labels and the row below it
  the day-of-month numbers. A per-employee **shift-count total** sits in the column after
  each month's days (e.g. col 35) — it is a spreadsheet summary, not input.
- **Blocks are shift slots.** The sheet repeats vertically in blocks (5 in May); each block
  is a **shift slot** (1st shift, 2nd shift, …). Within a block, rows are employees and
  columns are days.
- **A cell value is the location number** the person works that day in that slot. Cells may
  instead hold an **abbreviated substitute name** (`Сві`, `Хри`, `Вла`) meaning someone else
  covered; rows also carry annotations (`Загальні збори`, `Інвентура`, `Навчання`) that are
  not shifts.
- **Slot times come from the location.** Each location defines the window for each shift
  slot (`location_shift_slots`: location_id, slot_number, starts_at, ends_at). The importer
  resolves a cell to `(employee, date, location, slot window)`. A slot with no configured
  window for that location is reported, not guessed.
- **Names require an explicit mapping.** First names repeat within a block (one name appears twice)
  and across blocks, and some rows are placeholders (`Бариста 1`, `Бариста Н`). The importer
  lists every distinct name-row and the manager maps each to an employee record (or marks it
  ignored) **once**; the mapping is persisted and reused for later imports. The importer
  never guesses who gets paid.
- **The manager chooses the period to commit.** Parsing covers the whole sheet; only the
  selected month/pay period is written, so stale months are not imported by accident.
- Imported shifts are written with `source = 'imported'` and are subject to the same
  overlap rejection as any other approved shift.
- **Extraction (`extracted`):** hand-written schedules are uploaded, AI extracts shift rows,
  the manager reviews and approves → they become confirmed shifts.

## 6. Document extraction pipeline (AI, human-in-the-loop)

Hand-written documents arrive as **photos (JPG/PNG) and scanned PDFs**. Two document
types are extracted: **daily revenue reports** and **employee schedules**. (Employees,
levels, revenue percentages, and bonuses are entered directly in the app, not extracted.)

1. A manager uploads a photo/PDF. The API returns a presigned URL and the file lands in
   the **documents S3 bucket**.
2. An S3 put event triggers the **extraction Lambda**, which calls **Bedrock via the
   Anthropic SDK** — `AnthropicBedrockMantle`, model `anthropic.claude-opus-4-8`, vision
   input, bearer token from `AWS_BEARER_TOKEN_BEDROCK` — with a structured-output schema,
   returning extracted rows plus a confidence signal.
3. **High-confidence** extractions are staged as approved data automatically.
   **Low-confidence / poor-quality** extractions go to a `needs_review` queue.
4. The manager reviews the queue in the UI, edits/confirms, and the data is committed as
   `daily_revenue` rows or `shifts`.

When implementing the Bedrock call, invoke the `claude-api` skill first (per user's
standing rule) to confirm current model IDs and client usage. Adaptive thinking
(`thinking: {type: "adaptive"}`) and `output_config.effort`, not `budget_tokens`.

## 7. Architecture & components

- **Frontend:** TanStack (Router + Query) single-page app, built and hosted on **S3 +
  CloudFront** (HTTPS, SPA routing). Authenticates against Cognito.
- **API:** **API Gateway (HTTP API) + a single Node/TypeScript Lambda** with an internal
  router, protected by a Cognito JWT authorizer.
- **Async:** the **extraction Lambda**, triggered by S3 put events on the documents
  bucket.
- **Database:** **Aurora Serverless v2 Postgres**, accessed via the **RDS Data API** so
  Lambdas avoid VPC and connection-pool complexity.
- **Auth:** Cognito user pool with three groups (admin, manager, employee); employees are
  linked to their `cognito_sub`.
- **Storage:** two S3 buckets — frontend assets and uploaded documents.
- **Infrastructure as code:** **Terraform** for everything (Cognito, S3, CloudFront, API
  Gateway, Lambdas, Aurora, IAM).

## 8. Out of scope (YAGNI, for now)

PDF/CSV export, payroll/accounting integration, multi-currency, multi-tenant support,
Google Sheet import, and notifications. All can be added later without disrupting the
core design.