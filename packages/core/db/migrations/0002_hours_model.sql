-- Hours-based model: shifts carry explicit windows, locations carry working hours,
-- and an employee may work several shifts/locations per day.

-- Locations: working hours replace the single standard shift length.
ALTER TABLE locations ADD COLUMN opens_at TIME NOT NULL DEFAULT '08:00';
ALTER TABLE locations ADD COLUMN closes_at TIME NOT NULL DEFAULT '20:00';
ALTER TABLE locations ADD CONSTRAINT locations_hours_order CHECK (closes_at > opens_at);
ALTER TABLE locations DROP COLUMN standard_shift_hours;

-- Shifts: explicit window. Existing rows get the location's hours as their window.
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

-- A day may be split between people and across locations: relax the uniqueness.
ALTER TABLE shifts DROP CONSTRAINT shifts_employee_id_work_date_key;
ALTER TABLE shifts ADD CONSTRAINT shifts_employee_day_location_start_key
  UNIQUE (employee_id, work_date, location_id, starts_at);

-- Spreadsheet import is a third schedule source.
ALTER TYPE shift_source ADD VALUE IF NOT EXISTS 'imported';
