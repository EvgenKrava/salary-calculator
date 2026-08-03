CREATE TYPE shift_status AS ENUM ('requested', 'approved', 'rejected');
CREATE TYPE shift_source AS ENUM ('native', 'extracted');
CREATE TYPE revenue_source AS ENUM ('manual', 'extracted');
CREATE TYPE revenue_status AS ENUM ('pending', 'needs_review', 'approved', 'rejected');
CREATE TYPE doc_type AS ENUM ('revenue', 'schedule');
CREATE TYPE extraction_status AS ENUM ('processing', 'needs_review', 'approved', 'rejected');

CREATE TABLE levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  rate_per_hour NUMERIC(10, 2) NOT NULL CHECK (rate_per_hour >= 0)
);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  standard_shift_hours NUMERIC(5, 2) NOT NULL CHECK (standard_shift_hours > 0)
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  level_id UUID NOT NULL REFERENCES levels (id),
  revenue_percent NUMERIC(6, 4) NOT NULL DEFAULT 0 CHECK (revenue_percent >= 0 AND revenue_percent <= 1),
  cognito_sub TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees (id),
  location_id UUID NOT NULL REFERENCES locations (id),
  work_date DATE NOT NULL,
  status shift_status NOT NULL DEFAULT 'requested',
  source shift_source NOT NULL DEFAULT 'native',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);

CREATE TABLE daily_revenue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations (id),
  revenue_date DATE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  source revenue_source NOT NULL DEFAULT 'manual',
  status revenue_status NOT NULL DEFAULT 'approved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, revenue_date)
);

CREATE TABLE extraction_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type doc_type NOT NULL,
  s3_key TEXT NOT NULL,
  status extraction_status NOT NULL DEFAULT 'processing',
  confidence NUMERIC(4, 3),
  extracted_json JSONB,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE salary_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_start, period_end)
);

CREATE TABLE salary_run_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES salary_runs (id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees (id),
  hourly_pay NUMERIC(12, 2) NOT NULL,
  revenue_share NUMERIC(12, 2) NOT NULL,
  bonus NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  UNIQUE (run_id, employee_id)
);