-- Override reason HISTORY, not a single overwritten column.
--
-- Why this table exists: schedule_publications is one row per (year, month), so the original
-- design stored the override reason directly on it. That drops information — publish a month
-- with no conflict (reason NULL), add a draft that lands on a required day off, republish with
-- an overrideReason, and the reason vanishes into a column that already had a value (or, worse,
-- a later override silently replaces an earlier one). The product requirement is "every time
-- someone was scheduled on a required day off, and why" — a question a single column cannot
-- answer once more than one override happens in the same month.
--
-- schedule_publications.override_reason keeps its original meaning unchanged: the FIRST
-- publish's reason, left there so nothing that already reads that column breaks. Every
-- override — including the first — is ALSO appended here, so this table is the complete record
-- and that column is only ever a convenience snapshot of its first entry.
--
-- TEXT, not an enum or a foreign key to a lookup table: `reason` is free text a manager types,
-- same as schedule_publications.override_reason already is.
CREATE TABLE schedule_publication_overrides (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year       INT  NOT NULL,
  month      INT  NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (year, month) REFERENCES schedule_publications (year, month)
);

-- Every read is "history for this month" (GET /api/schedule-publications), never a scan of the
-- whole table.
CREATE INDEX schedule_publication_overrides_year_month_idx
  ON schedule_publication_overrides (year, month);
