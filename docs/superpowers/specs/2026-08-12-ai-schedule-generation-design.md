# AI Schedule Generation — Design

**Date:** 2026-08-12
**Status:** Approved in chat (generator/coverage/limits/home-locations decisions 2026-08-12).

## 1. Problem

A manager spends hours hand-building the робочий графік for each two-week pay period.
The constraints are mechanical — who wants which days off, how many people each café
needs, who works where, nobody too many days in a row — but satisfying all of them by
hand across ~15 people × 15 days × several locations is slow, and mistakes surface as
day-off conflicts at publish time or as unfair schedules.

The app already has the pieces that make this automatable: draft shifts invisible to
payroll and staff, a people×days authoring grid, day-off requests (required/preferred),
and a publish gate that blocks on required-day-off conflicts. What's missing is the
knowledge of coverage needs and working locations, and the generator itself.

## 2. Decisions (user-approved 2026-08-12)

1. **Pure LLM generation** — Claude via Bedrock builds the schedule from the full
   constraint picture. (Deterministic-solver alternatives were offered and declined.)
   Consequence, accepted: the server MUST validate every AI assignment against the hard
   constraints before writing anything, with one feedback retry — an LLM will
   occasionally violate a constraint, and an invalid draft that silently lands defeats
   the time-saving purpose.
2. **Coverage need = per-location staffing config** — a new admin setting: how many
   people each location needs per weekday.
3. **Max consecutive working days is per employee** — a field on the employee card.
4. **Home locations (робочі локації) live on the employee card**, staff-edited.
   The generator prefers home locations; an off-home assignment is allowed only when
   coverage is otherwise impossible and is always flagged for human review. Manual
   off-home assignment in the grid warns but stays one click.

## 3. Data model (migration 0009_ai_scheduling.sql)

```sql
-- Which locations an employee normally works. No rows = works nowhere by default:
-- the generator skips them and the grid warns on ANY assignment, so a new employee
-- is configured deliberately rather than schedulable everywhere by accident.
CREATE TABLE employee_locations (
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, location_id)
);

-- People needed per location per weekday (0 = Sunday .. 6 = Saturday, matching
-- EXTRACT(DOW)). A missing row means 0 — the location runs unstaffed that day and the
-- generator schedules nobody. people_needed is people PER SLOT that day (see §5).
CREATE TABLE location_staffing (
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  weekday       INT  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  people_needed INT  NOT NULL CHECK (people_needed >= 0),
  PRIMARY KEY (location_id, weekday)
);

ALTER TABLE employees ADD COLUMN max_consecutive_days INT NOT NULL DEFAULT 5
  CHECK (max_consecutive_days BETWEEN 1 AND 14);

-- One row per generation run: the audit trail for "why did the AI do that", and the
-- job record the UI polls. TEXT + CHECK per project convention, never enums.
CREATE TABLE generation_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL,
  model_id     TEXT,
  raw_response JSONB,
  report       JSONB,            -- validation summary: written/dropped/flagged counts + reasons
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
```

Notes:
- `shifts` gains nothing: AI drafts are ordinary `status='draft'`, `source='generated'`
  — which requires widening the shifts source CHECK (`native|extracted|imported` +
  `generated`) and the schema.ts pgEnum and core type union (three places, project
  convention).
- Off-home flagging is DERIVED (shift's location ∉ employee_locations), not stored —
  no denormalized flag to drift.

## 4. Generation flow

1. **Trigger**: on Скласти графік the manager picks a half-month (1–15 / 16–кінець,
   matching pay periods) and hits «Згенерувати чернетку (AI)». POST
   `/api/generation-jobs` `{year, month, half}` → 202 + job id. Only ONE non-terminal
   job per period at a time (409 otherwise). The month must not be published (409, same
   rule as day-off edits).
2. **Async execution**: the API Lambda cannot hold a 30–60s LLM call inside a normal
   request cheaply, and the extraction Lambda already owns the Bedrock plumbing
   (AnthropicBedrockMantle, `anthropic.` model prefix, tool-forced structured output).
   The generation runs THERE: the API writes the job row and invokes the extraction
   Lambda async (Event invocation) with `{kind: 'generate-schedule', jobId}`; the
   Lambda's handler branches on `kind` (it already receives S3 events; this adds a
   direct-invoke path). It loads the constraint picture from the DB, calls Claude,
   validates, writes drafts, updates the job row.
3. **Constraint picture sent to the model** (all Ukrainian-labeled, compact JSON):
   period days; locations with their slots and per-weekday staffing needs; employees
   with home locations, max_consecutive_days, required and preferred day-offs in the
   period, and approved shifts adjacent to the period boundary (so consecutive-day
   counting sees the run-in from the previous period).
4. **Model contract**: forced tool call `propose_schedule` returning
   `{assignments: [{employeeId, locationId, date, slotNumber}], notes: [{employeeId?, date?, reason}]}`
   — notes are the Ukrainian explanations for trade-offs (off-home use, unfillable
   slots, preferred day-offs not honored). Model: the default from the extraction
   package's config (currently `anthropic.claude-opus-5`), adaptive thinking.
5. **Server-side validation — the hard gate.** Every assignment checks:
   - employee exists, active; location/slot exist; date in period
   - not on a REQUIRED day off (hard reject)
   - would not exceed the employee's max_consecutive_days (counting existing approved
     shifts too)
   - no duplicate (employee, date, slot); no overlap with an existing approved shift
   - staffing per (location, weekday, slot) not exceeded
   Violations → collect and retry ONCE with the violation list appended to the prompt.
   After the retry, still-invalid assignments are DROPPED and listed in the report;
   valid ones proceed. Preferred day-offs and off-home use are NOT rejected — they are
   flagged in the report (soft constraints, human judgment).
6. **Write**: valid assignments land as draft shifts (`source='generated'`), slot
   window resolved per location exactly as the grid's setCell does. Existing drafts in
   the period are REPLACED (delete drafts, keep approved) — regeneration is idempotent,
   and hand-edited drafts the manager wants to keep are protected by a confirm in the
   UI ("existing drafts will be replaced").
7. **Report** (job row `report` JSONB): counts written/dropped/flagged; per-item
   reasons; the model's own notes. Rendered in the UI as the generation summary.

## 5. Coverage semantics

`people_needed` is per slot: a location with 2 slots and people_needed=1 gets one
person per slot (2 shifts/day). This matches the workbook's shape (a block per slot)
and the grid (one grid per slot). people_needed>1 means the generator fills that many
parallel shifts per slot — the grid already renders one cell per (person, day), so
parallel assignment shows as multiple people having the same location that day.

## 6. UI

1. **Employee card** (EmployeesRoute): home-location checkboxes (from `locations`),
   and a max-consecutive-days numeric field (mono). Both staff-editable — same place
   day-offs are managed for the admin path.
2. **Setup**: a staffing panel — locations × weekdays grid of small numeric inputs
   (design-developer agent decides form; per-slot semantics stated in the hint copy).
   Admin-only, like the pay matrix.
3. **Скласти графік**: the «Згенерувати чернетку (AI)» button (secondary — publish
   keeps the screen's amber), period = the currently displayed month's halves (picker
   for 1st/2nd half). While a job runs: status line with polling (same pattern as
   extraction review), the grid stays usable. On completion: the generation report
   panel (written/dropped/flagged + model notes, Ukrainian) above the grid, dismissible.
4. **Off-home marking**: grid cells whose shift is off-home get a distinct treatment +
   word/glyph (never color alone); the publish preview lists off-home assignments as a
   third warning class (like preferred-day-off conflicts — warn, don't block).
   Manual off-home assignment via the cell popover: the popover marks non-home
   locations and asks one extra confirm click.
5. **Generation history**: not a screen; the last job's report is reachable from the
   grid. Full history stays in the DB for audits.

## 7. API

- `POST /api/generation-jobs` (manager/admin) — create + invoke; 409 on running job or
  published month.
- `GET /api/generation-jobs/:id` (manager/admin) — poll status + report.
- `GET /api/generation-jobs?year=&month=&half=` — latest job for the period.
- `PUT /api/employees/:id/locations` (manager/admin) — set home locations (full list).
- `GET /api/employees/:id/locations` — list.
- `PATCH /api/employees/:id` gains `maxConsecutiveDays`.
- `GET/PUT /api/location-staffing` (GET manager/admin, PUT admin) — cells like pay-rates.
- Publish preview response gains `offHome: [{employeeId, employeeName, workDate, locationId}]`.

## 8. Testing

- Core: pure validation module (`validateAssignments`) — every hard constraint, the
  consecutive-days counter crossing the period boundary, dedup/overlap logic. Pure
  function, exhaustively unit-tested; this is the payroll-protecting layer.
- Extraction: prompt assembly snapshot (constraint picture completeness); response
  parsing; retry-on-violation flow with a stubbed client; job status transitions incl.
  failure writing `error`.
- API: role gating; 409 rules (running job, published month); staffing/locations CRUD;
  draft-replacement semantics (approved shifts survive regeneration).
- Web: staffing panel, employee-card fields, generate button + polling + report render,
  off-home cell treatment, publish-preview third warning class. Real hooks + stubbed
  fetch, as established.
- PGlite/Data API list check (memory): JSONB columns — the Data API serializes JSONB as
  strings; verify the read path casts/parses (`::text` + JSON.parse or Drizzle jsonb
  mapping verified in deploy task). New CHECK values via TEXT, never enum.

## 9. Out of scope

- Auto-publish (the manager always reviews; publishing stays manual).
- Fairness metrics/quotas beyond even-handed prompting (revisit after real use).
- Editing staffing per specific DATE (weekday-level only, this stage).
- Cost controls beyond one-job-at-a-time (a run is ~$0.05–0.15 on the separate
  Bedrock account).
