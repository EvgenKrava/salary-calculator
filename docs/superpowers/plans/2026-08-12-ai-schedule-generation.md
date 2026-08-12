# AI Schedule Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude drafts a half-month schedule as ordinary draft shifts, hard-validated server-side, correctable in the existing grid.

**Architecture:** Migration 0009 (employee_locations, location_staffing, max_consecutive_days, generation_jobs, + 'generated' shift source); a pure validator in core; the LLM call and job execution in the extraction Lambda (it owns Bedrock) behind a direct-invoke branch; thin API routes for jobs/config; UI on the existing grid.

**Tech Stack:** existing — Drizzle/PGlite, Hono, AnthropicBedrockMantle (tool-forced structured output), React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-12-ai-schedule-generation-design.md` (approved).

## Global Constraints

- Migrations: TEXT + CHECK never enums; after SQL edits run `pnpm --filter @salary/core generate:migrations`, add the named export in migrations.ts, extend migrations.test.ts. The shifts `source` CHECK widens — that list lives in THREE places: the migration CHECK, schema.ts pgEnum, core types.ts union.
- PGlite/Data API divergences (all five known classes — see memory/ledger): TEXT+CHECK; toSqlTime for TIME; single-statement handler SQL; DATE as strings, never `new Date(iso)`; cast exotic result types (regclass etc.) `::text`. **JSONB is a candidate sixth**: the Data API returns JSONB as a string field — the read path must parse defensively; the deploy task verifies it live.
- LLM calls: `AnthropicBedrockMantle`, model IDs with `anthropic.` prefix, tool-forced structured output, adaptive thinking — copy the extraction package's existing idioms (bedrock.ts, buildRequest.ts), do not hand-roll.
- All UI copy in i18n.ts; 3-form plural(); extensionless imports; web tests = real hooks + stubbed fetch; NEVER add Co-Authored-By or generated-with trailers.
- After each task: `pnpm -r test` + `pnpm -r typecheck` green (rebundle api if bundle test stale).

## Deploy-order / infra note (Task 7 depends on it)

The API Lambda must async-invoke the extraction Lambda. That needs: (a) `lambda:InvokeFunction` on the extraction function in the API role, (b) the extraction function name in the API's env (`GENERATION_FUNCTION_NAME`), (c) DB env vars + longer timeout on the extraction Lambda if not already there. This is a **Terraform change** (infra/) — write it in Task 4, but `terraform apply` happens only in Task 7 with explicit user authorization, per standing rule.

---

### Task 1: Migration 0009 + schema + types

**Files:** Create `packages/core/db/migrations/0009_ai_scheduling.sql`; modify `packages/core/src/migrations.ts`, `packages/core/src/types.ts`, `packages/api/src/schema.ts`; tests `packages/core/test/migrations.test.ts`, `packages/api/test/schema.test.ts`.

**Interfaces (produced):** core types:
```ts
export type ShiftSource = 'native' | 'extracted' | 'imported' | 'generated';
export interface EmployeeLocation { employeeId: string; locationId: string; }
export interface LocationStaffing { locationId: string; weekday: number; peopleNeeded: number; }
export type GenerationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
// Employee gains maxConsecutiveDays: number
```

- [ ] **Step 1: the SQL** — spec §3 verbatim, PLUS the source widening:

```sql
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_source_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_source_check
  CHECK (source IN ('native', 'extracted', 'imported', 'generated'));
```

(Check 0005's actual constraint name first — `\d shifts` on a PGlite or read 0005's SQL; use the real name.) Then the four new tables/columns from spec §3 exactly (employee_locations, location_staffing, max_consecutive_days with CHECK 1..14 DEFAULT 5, generation_jobs with TEXT status CHECK).

- [ ] **Step 2:** regenerate, named export `AI_SCHEDULING_SQL` (doc comment: "Home locations, staffing needs, consecutive-day limits and generation jobs for AI drafting."), migrations.test.ts row.
- [ ] **Step 3:** types.ts changes above; schema.ts Drizzle tables (match array-form table config used by siblings; `jsonb` columns via drizzle's `jsonb()`), employees gains `maxConsecutiveDays: integer('max_consecutive_days').notNull().default(5)`, shifts source pgEnum widened.
- [ ] **Step 4:** schema.test.ts: rejected writes — bad weekday (7), negative people_needed, bad job status, source 'generated' ACCEPTED now; max_consecutive_days 0 and 15 rejected.
- [ ] **Step 5:** full suite; commit `"Add AI-scheduling tables and the generated shift source"`.

---

### Task 2: Core validator (pure) — the payroll-protecting layer

**Files:** Create `packages/core/src/scheduleValidation.ts`, `packages/core/test/scheduleValidation.test.ts`; export from index.ts.

**Interfaces (produced; Task 3 consumes verbatim):**
```ts
export interface ProposedAssignment { employeeId: string; locationId: string; date: string; slotNumber: number; }
export interface ValidationContext {
  period: PayPeriod;
  employees: { id: string; active: boolean; maxConsecutiveDays: number; homeLocationIds: string[] }[];
  locations: { id: string; slots: { slotNumber: number; startsAt: string; endsAt: string }[] }[];
  staffing: LocationStaffing[];                    // per (location, weekday): people per slot
  requiredDaysOff: { employeeId: string; date: string }[];
  preferredDaysOff: { employeeId: string; date: string }[];
  approvedShifts: { employeeId: string; locationId: string; workDate: string; startsAt: string; endsAt: string }[]; // in-period AND boundary-adjacent
}
export interface RejectedAssignment { assignment: ProposedAssignment; reason:
  'unknown_employee' | 'inactive_employee' | 'unknown_location' | 'unknown_slot' | 'outside_period'
  | 'required_day_off' | 'consecutive_limit' | 'duplicate' | 'overlaps_approved' | 'staffing_exceeded'; }
export interface FlaggedAssignment { assignment: ProposedAssignment; flag: 'off_home' | 'preferred_day_off'; }
export interface ValidationResult { accepted: ProposedAssignment[]; rejected: RejectedAssignment[]; flags: FlaggedAssignment[]; }
export function validateAssignments(proposed: ProposedAssignment[], ctx: ValidationContext): ValidationResult;
```

Rules the tests must pin (write tests FIRST, red→green, one describe per reason):
- Hard rejects in the order listed above; an assignment failing two checks reports the FIRST (deterministic).
- `consecutive_limit`: a run of distinct worked DATES (any location/slot) strictly greater than maxConsecutiveDays rejects the assignment that extends it. Counting includes ctx.approvedShifts AND already-accepted proposals, and crosses the period start (approved shifts before day 1 count into the run). Dates compared as strings.
- `duplicate`: same (employee, date, slotNumber) within proposals or vs approved.
- `overlaps_approved`: proposal's slot window (from ctx.locations) vs approved shift windows, half-open interval, same employee+date.
- `staffing_exceeded`: per (location, date→weekday, slot), accepted count must not exceed peopleNeeded; weekday from the DATE STRING via `Date.UTC` parse of parts (never `new Date(iso)` — split, then `new Date(Date.UTC(y,m-1,d)).getUTCDay()`).
- Flags never reject: `off_home` when locationId ∉ homeLocationIds; `preferred_day_off` on a preferred date. Both can co-occur (two flag entries).
- Missing staffing row = 0 needed = everything there rejects `staffing_exceeded`.

- [ ] Steps: failing tests (≥20 cases incl. boundary run-in, dedupe-order determinism, flag co-occurrence) → implement → full suite → commit `"Add the pure validator that gates AI schedule proposals"`.

---

### Task 3: Extraction Lambda — the generation branch

**Files:** Create `packages/extraction/src/generateSchedule.ts` (+ prompt builder + response schema), modify `packages/extraction/src/handler.ts` (branch on direct-invoke event), `packages/extraction/src/db.ts` (new queries); tests `packages/extraction/test/generateSchedule.test.ts`, extend `handler.test.ts`.

**Interfaces:** Consumes `validateAssignments` etc. from `@salary/core`. Produces: handler accepts `{ kind: 'generate-schedule', jobId: string }` alongside S3 events (discriminate: S3 events have `Records`; direct invokes have `kind`). Job row transitions pending→running→succeeded|failed; `report` JSONB `{written, dropped, flagged, rejected: RejectedAssignment[], flags: FlaggedAssignment[], notes: [{employeeId?, date?, reason}]}`.

Key requirements:
- **Prompt** (Ukrainian system prompt; compact JSON user payload): period days; per-location slots + per-weekday staffing; per-employee home locations, maxConsecutiveDays, required/preferred day-offs, boundary-adjacent approved shifts. Instruct: prefer home locations, off-home ONLY when a slot cannot otherwise be filled and add a note; honor preferred day-offs when coverage allows; distribute days evenly; NEVER assign on a required day off; explain every trade-off in `notes`, Ukrainian.
- **Tool contract**: forced tool `propose_schedule`, input schema `{assignments: [...], notes: [...]}` — copy buildRequest.ts's tool-forcing idiom and parseResponse.ts's defensive parsing (unknown fields tolerated, missing required → job failed with error, never a crash).
- **Retry loop**: call → validate → if `rejected` non-empty and attempt 1, append a Ukrainian correction message listing each rejection (assignment + reason) and call once more (conversation continuation, same tool forcing). After attempt 2: drop remaining rejects.
- **Write**: delete existing DRAFT shifts in period (approved untouched), insert accepted as `status='draft', source='generated'`, window from the location's slot (toSqlTime). Then update job row (succeeded, report, finished_at). ANY thrown error → job failed + `error` text (the UI must never poll forever).
- **DB access**: this Lambda already talks to the DB via the Data API (db.ts) — extend, matching existing query style; single statements only.
- Tests with a stubbed Bedrock client (bedrockResponse.ts precedent): happy path; retry path (first response violates, second clean — assert the correction message content); still-invalid-after-retry drops and reports; model refusal/garbage → failed job with error; draft-replacement leaves approved rows; job transitions.

- [ ] Steps: red tests → implement → full suite → commit `"Generate schedule drafts in the extraction Lambda behind a hard validator"`.

---

### Task 4: API routes + Terraform

**Files:** Create `packages/api/src/routes/generationJobs.ts`, `packages/api/src/routes/employeeLocations.ts`, `packages/api/src/routes/locationStaffing.ts`; modify `employees.ts` (maxConsecutiveDays in schemas/DTO), `schedulePublications.ts` (preview + publish response gains `offHome`), `app.ts` (mounts); modify `infra/lambda.tf`/`iam.tf` (invoke permission + env; NO apply). Tests: one file per new route + publish test extension.

Contracts (Task 5 consumes verbatim):
- `POST /api/generation-jobs` {year, month, half:1|2} → 202 {id}; 409 `{error, code:'job_running'}` if a pending/running job exists for the period; 409 `{error, code:'month_published'}` if published. Uses `payPeriodsForMonth`. Writes job row, then `LambdaClient.send(InvokeCommand{InvocationType:'Event', FunctionName: env.GENERATION_FUNCTION_NAME, Payload: {kind:'generate-schedule', jobId}})`. In tests, inject a fake invoker (constructor param like the verifier pattern in app.ts).
- `GET /api/generation-jobs/:id` → {id, status, report, error, createdAt, finishedAt}. JSONB `report` may arrive as string from the Data API — parse defensively in toDto (typeof === 'string' ? JSON.parse : as-is).
- `GET /api/generation-jobs?year&month&half` → latest job for period or `{}`.
- `GET/PUT /api/employees/:id/locations` — PUT body {locationIds: string[]} replaces the set (delete+insert, transaction); employee 403; unknown employee 404.
- `GET /api/location-staffing` (manager/admin) → all cells; `PUT /api/location-staffing` (admin) {locationId, weekday, peopleNeeded} upsert; zod bounds → 400.
- Publish preview/POST: `offHome` computed by joining draft shifts against employee_locations (derived, not stored) — `{employeeId, employeeName, workDate, locationId}[]`; warns, never blocks.
- Terraform: aws_iam_role_policy addition (invoke extraction fn ARN), `GENERATION_FUNCTION_NAME` env on API Lambda, DB env + timeout ≥120s on extraction Lambda if missing. Plain `terraform fmt`-clean diff, committed, NOT applied.

- [ ] Steps: red tests (role matrix, 409 codes, replace semantics, offHome derivation, defensive JSONB parse with a string fixture) → implement → full suite → commit `"Add generation-job, staffing and home-location APIs; flag off-home in publish"`.

---

### Task 5: Web data layer

**Files:** modify `apps/web/src/lib/queries.ts`, `i18n.ts`; test `queries.test.tsx` (real hooks + stubbed fetch).

Hooks (exact): `useGenerationJob(params:{year,month,half})` (query, `refetchInterval: (q)=> q.state.data?.status==='pending'||q.state.data?.status==='running' ? 3000 : false`), `useStartGeneration()` (mutation, on success invalidate ['generation-job'] and ['shifts']), `useEmployeeLocations(employeeId)`, `useSetEmployeeLocations()` (invalidate ['employee-locations', id]), `useLocationStaffing()`, `useSetLocationStaffing()`; `useUpdateEmployee` body gains `maxConsecutiveDays?`; PublishAssessment type gains `offHome`. On generation-job reaching 'succeeded': the POLLING component invalidates ['shifts'] (drafts appeared) — put the invalidation in the UI task's effect, but expose status cleanly here.

i18n group `generate`: `button: 'Згенерувати чернетку (AI)'`, `firstHalf/secondHalf`, `running: 'Генерується…'`, `confirmReplace: 'Наявні чернетки за цей період буде замінено. Продовжити?'`, `reportTitle: 'Результат генерації'`, `written/dropped/flagged` labels + 3-form plural for counts, `offHomeTitle: 'Не своя локація'`, `offHomeWarn`, `failed: 'Не вдалося згенерувати'`, staffing panel copy (`staffingTitle: 'Потреба в людях'`, weekday labels — REUSE the existing weekday names the calendar uses), employee-card copy (`homeLocations: 'Робочі локації'`, `maxDays: 'Макс. днів підряд'`).

- [ ] Steps: red hook tests (URLs/bodies/params incl. polling interval logic as a unit, invalidation keys) → implement → web suite + typecheck → commit `"Add generation, staffing and home-location hooks and copy"`.

---

### Task 6: UI (design-developer agent)

**Files:** modify `ScheduleGrid.tsx`/`scheduleGrid.css` (generate button + period picker + status + report panel + off-home cell treatment + popover off-home confirm), `PublishPanel.tsx` (offHome warning class), `EmployeesRoute.tsx` (home-location checkboxes + maxDays field), `SetupRoute.tsx` (staffing panel); create `apps/web/test/generation.test.tsx` + extend existing.

Behavioral requirements (agent owns markup per charter):
1. Generate button on the grid toolbar, SECONDARY variant (publish keeps the amber); half-period picker beside it; click → confirm (t.generate.confirmReplace) → POST → status line (role="status") polling; on succeeded → invalidate shifts, render dismissible report panel (written/dropped/flagged counts, rejection reasons, model notes — all Ukrainian); on failed → failure panel with error, LoadFailure-consistent.
2. Off-home cells: word/glyph + tint (never color alone), accessible label extended — same approach as day-off tints. Popover: non-home locations marked; choosing one requires a second confirming click (match the clear-confirmation idiom).
3. Publish panel: offHome list as a third warning class (like preferred conflicts — warn not block), each entry named.
4. Employee card: home-location checkboxes (all locations, checked = home), maxDays numeric mono field (1–14, error below field).
5. Staffing panel on Setup, admin-only: locations × weekdays numeric grid, per-slot semantics in hint copy, same disclosure/commit conventions as the pay matrix.
6. 390px per house pattern; jsdom tests for logic + requests, Playwright for layout; mutation-check at least the off-home-confirm test.

- [ ] Steps: per charter (system.md first) → red tests → implement → self-audit → full suite → commit(s).

---

### Task 7: Deploy + live verification

No code. Order: (1) commit/push everything; (2) `terraform plan` for the IAM/env changes — SHOW the plan to the user and get explicit approval before `apply` (standing rule); (3) apply; (4) bundle + deploy BOTH Lambdas (api + extraction — extraction now carries generation code); (5) invoke migrate (expect applied:1 skipped:8); (6) live checks: staffing PUT/GET, employee locations PUT/GET, JSONB report read-back through the real Data API (create a trivial job row via a failed-fast generation or direct check — verify the string-vs-object parse), then ONE real generation run against seeded test data (2 employees, 1 location, staffing 1) — verify drafts land, report reads, off-home flags appear in publish preview; (7) frontend build/sync/invalidate; (8) browser walkthrough; (9) ledger.

---

## Self-Review

**Spec coverage:** §3→Task 1; §4.5 validator→Task 2; §4.2–4.7 flow→Task 3; §7 API→Task 4; §6 UI→Tasks 5–6; §8 testing→per task; JSONB divergence check→Tasks 4+7. Off-home derivation §3-note→Task 4 (publish) + Task 6 (grid). One-job-at-a-time §4.1→Task 4 409.

**Placeholders:** none — each task carries interfaces, contracts, and test lists; Task 6 is behavioral by design (agent charter).

**Type consistency:** ProposedAssignment/ValidationContext/ValidationResult defined once (Task 2), consumed by name in Task 3; job DTO fields identical between Task 4 route and Task 5 hook; `offHome` shape identical in Task 4 response and Task 5 type; GenerationJobStatus union (Task 1) used in Tasks 3–5.

**Known risks, stated:** (1) direct-invoke event discrimination in a Lambda that also receives S3 events — Task 3 tests both shapes; (2) JSONB through the Data API is an unverified divergence candidate — defensive parse in Task 4, live proof in Task 7; (3) Terraform apply needs user authorization — Task 7 stops for it explicitly; (4) LLM nondeterminism — bounded by the validator; tests stub the client, the live run in Task 7 is the only real call.
