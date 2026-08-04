-- Hours-based model: shifts carry explicit windows, locations carry working hours,
-- and an employee may work several shifts/locations per day.

-- Locations: working hours replace the single standard shift length. The old model
-- never recorded an opening time, so '08:00' is the best available default for
-- opens_at — but closes_at MUST be derived from the real standard_shift_hours (not a
-- flat default), or a location whose real shift was e.g. 6h would silently become
-- whatever the default window is, and that lost length can never be recovered once
-- standard_shift_hours is dropped.
ALTER TABLE locations ADD COLUMN opens_at TIME NOT NULL DEFAULT '08:00';
ALTER TABLE locations ADD COLUMN closes_at TIME;

UPDATE locations
SET closes_at = date_trunc('minute', (opens_at + (standard_shift_hours * INTERVAL '1 hour')))::time;

ALTER TABLE locations ALTER COLUMN closes_at SET NOT NULL;
ALTER TABLE locations ADD CONSTRAINT locations_hours_order CHECK (closes_at > opens_at);
-- Whole-minute guard: a seconds-bearing time would collapse to an equal 'HH:MM' after
-- the API's display truncation, making hoursBetween throw and the salary run 500 with
-- no way to repair the row — so such rows must be unstorable.
ALTER TABLE locations ADD CONSTRAINT locations_hours_whole_minute
  CHECK (date_trunc('minute', opens_at::interval) = opens_at::interval
     AND date_trunc('minute', closes_at::interval) = closes_at::interval);

ALTER TABLE locations DROP COLUMN standard_shift_hours;

-- Shifts: explicit window. Existing rows get the location's (now length-preserving)
-- hours as their window.
ALTER TABLE shifts ADD COLUMN starts_at TIME;
ALTER TABLE shifts ADD COLUMN ends_at TIME;

UPDATE shifts s
SET starts_at = l.opens_at,
    ends_at   = l.closes_at
FROM locations l
WHERE l.id = s.location_id
  AND (s.starts_at IS NULL OR s.ends_at IS NULL);

ALTER TABLE shifts ALTER COLUMN starts_at SET NOT NULL;
ALTER TABLE shifts ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE shifts ADD CONSTRAINT shifts_window_order CHECK (ends_at > starts_at);
ALTER TABLE shifts ADD CONSTRAINT shifts_window_whole_minute
  CHECK (date_trunc('minute', starts_at::interval) = starts_at::interval
     AND date_trunc('minute', ends_at::interval) = ends_at::interval);

-- A day may be split between people and across locations: relax the uniqueness.
ALTER TABLE shifts DROP CONSTRAINT shifts_employee_id_work_date_key;
ALTER TABLE shifts ADD CONSTRAINT shifts_employee_day_location_start_key
  UNIQUE (employee_id, work_date, location_id, starts_at);

-- Spreadsheet import is a third schedule source.
ALTER TYPE shift_source ADD VALUE IF NOT EXISTS 'imported';
