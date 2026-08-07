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
