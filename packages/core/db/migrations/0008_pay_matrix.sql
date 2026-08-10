-- Both pay parameters move to a (level, location) matrix. A level becomes a pure label:
-- the same level pays a different guaranteed day rate AND a different revenue percent at
-- different locations. The old single-grain columns drop outright — production was
-- recreated empty on 2026-08-09 and committed salary runs snapshot their own figures, so
-- nothing historical reads these columns.
--
-- ON DELETE CASCADE: matrix cells are configuration, not payroll history. Deleting a
-- level or location takes its cells along instead of blocking on an FK that protects
-- nothing (history lives in salary_run_lines).

CREATE TABLE pay_rates (
  level_id        UUID NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  rate_per_day    NUMERIC(10,2) NOT NULL CHECK (rate_per_day >= 0),
  revenue_percent NUMERIC(6,5)  NOT NULL DEFAULT 0 CHECK (revenue_percent >= 0 AND revenue_percent <= 1),
  PRIMARY KEY (level_id, location_id)
);

ALTER TABLE levels DROP COLUMN rate_per_day;

ALTER TABLE employees DROP COLUMN revenue_percent;
