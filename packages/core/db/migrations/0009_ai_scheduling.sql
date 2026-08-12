-- AI schedule generation: home locations, staffing needs, consecutive-day limits and
-- generation jobs for AI drafting.
-- Design: docs/superpowers/specs/2026-08-12-ai-schedule-generation-design.md
--
-- generation_jobs.status is TEXT + CHECK, never a Postgres enum — the RDS Data API sends
-- parameters as untyped text and Postgres will not implicitly coerce text to an enum, while
-- PGlite does. See 0005_enum_to_text.sql for the failure mode this avoids.

-- AI drafts are ordinary shifts (status='draft', source='generated'), so the source CHECK
-- widens. The list must stay in step with schema.ts's pgEnum and types.ts's ShiftSource union.
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_source_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_source_check
  CHECK (source IN ('native', 'extracted', 'imported', 'generated'));

-- Which locations an employee normally works. No rows = works nowhere by default: the
-- generator skips them and the grid warns on ANY assignment, so a new employee is configured
-- deliberately rather than schedulable everywhere by accident.
CREATE TABLE employee_locations (
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, location_id)
);

-- People needed per location per weekday (0 = Sunday .. 6 = Saturday, matching
-- EXTRACT(DOW)). A missing row means 0 — the location runs unstaffed that day and the
-- generator schedules nobody. people_needed is people PER SLOT that day (see spec §5).
CREATE TABLE location_staffing (
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  weekday       INT  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  people_needed INT  NOT NULL CHECK (people_needed >= 0),
  PRIMARY KEY (location_id, weekday)
);

ALTER TABLE employees ADD COLUMN max_consecutive_days INT NOT NULL DEFAULT 5
  CHECK (max_consecutive_days BETWEEN 1 AND 14);

-- One row per generation run: the audit trail for "why did the AI do that", and the job
-- record the UI polls.
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
