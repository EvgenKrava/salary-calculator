-- Spreadsheet schedule import (design spec 5.1): slot windows per location, and a
-- persisted mapping from spreadsheet name-rows to employee records.

CREATE TABLE location_shift_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, slot_number),
  -- Same window rules as shifts: ordered, whole minutes, strictly before 24:00 so the
  -- 'HH:MM' API contract can round-trip the value.
  CONSTRAINT location_shift_slots_window_order CHECK (ends_at > starts_at),
  CONSTRAINT location_shift_slots_below_24 CHECK (starts_at < '24:00:00' AND ends_at < '24:00:00'),
  CONSTRAINT location_shift_slots_whole_minute CHECK (
    date_trunc('minute', starts_at::interval) = starts_at::interval
    AND date_trunc('minute', ends_at::interval) = ends_at::interval
  )
);

-- One row per distinct spreadsheet name. Either it maps to an employee, or it is marked
-- ignored (placeholder rows like 'Бариста 1'), never both.
CREATE TABLE schedule_name_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL UNIQUE,
  employee_id UUID REFERENCES employees (id) ON DELETE CASCADE,
  ignored BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_name_map_resolved CHECK (
    (employee_id IS NOT NULL AND ignored = FALSE)
    OR (employee_id IS NULL AND ignored = TRUE)
  )
);
