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
hourly_pay     = Σ over E's confirmed shifts in period:
                   E.level.rate_per_hour × shift.location.standard_shift_hours

revenue_share  = Σ over E's confirmed shifts in period:
                   E.revenue_percent × daily_revenue(shift.location, shift.date)

personal_bonus = manual amount entered per employee at run time

total          = hourly_pay + revenue_share + personal_bonus
```

Key rules:

- **Revenue share is attributed by shift.** Each employee gets their own full percent of
  the *full* daily revenue of each location they worked, on each day they worked it —
  independent of hours and independent of other staff working the same location that day.
- **Hourly pay uses a fixed full shift per day**, and the shift length is defined
  **per location**. A scheduled day at a location contributes
  `level.rate_per_hour × location.standard_shift_hours`.
- **One-shot run.** The manager enters personal bonuses, runs the calculation, and the
  result is saved as the final immutable record — immediately visible to the affected
  employee. There is no separate draft/finalize step.
- **Blocker rule.** If any worked `(location, date)` has no approved daily revenue figure,
  the run flags those gaps and will not finalize until they are resolved, so revenue share
  is never silently understated.

## 4. Data model (Aurora Serverless v2 Postgres)

- **levels** (id, name, rate_per_hour)
- **locations** (id, name, standard_shift_hours)
- **employees** (id, name, level_id, revenue_percent, cognito_sub nullable, active)
- **shifts** (id, employee_id, location_id, work_date,
  status: `requested` | `approved` | `rejected`,
  source: `native` | `extracted`) — unique per (employee, work_date)
- **daily_revenue** (id, location_id, revenue_date, amount,
  source: `manual` | `extracted`, status)
- **extraction_jobs** (id, doc_type: `revenue` | `schedule`, s3_key,
  status: `processing` | `needs_review` | `approved` | `rejected`,
  confidence, extracted_json, reviewed_by)
- **salary_runs** (id, period_start, period_end, created_by, created_at)
- **salary_run_lines** (id, run_id, employee_id, hourly_pay, revenue_share, bonus, total)
  — a snapshot of the computed breakdown at run time

Assumptions:

- An employee works **at most one location per day** (one shift per employee per day).
- The `salary_run_lines` snapshot preserves the computed values even if inputs change
  later.

## 5. Scheduling (two input paths → one confirmed schedule)

Both paths converge on the same `shifts` table; the calculation only reads
`status = approved`.

- **Native scheduling:** an employee submits a shift request (location + date) → the
  manager approves or rejects it → approved shifts form the confirmed schedule.
- **Extraction:** hand-written schedules are uploaded, AI extracts shift rows, the
  manager reviews and approves → they become confirmed shifts.

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