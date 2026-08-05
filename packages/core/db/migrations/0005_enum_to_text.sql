-- Replace Postgres ENUM columns with TEXT + CHECK.
--
-- Why: the RDS Data API sends parameters as untyped text, and Postgres will not implicitly
-- coerce text to an enum — every insert failed with
--   column "source" is of type revenue_source but expression is of type text
-- PGlite (used by every test) DOES coerce implicitly, so all 409 tests passed while creating
-- revenue, a shift, or an extraction job was impossible in production. Ten write sites across
-- four route files were affected; casting each one is a fix that the eleventh site forgets.
--
-- TEXT + CHECK gives identical integrity: the database still rejects any value outside the
-- allowed set. It also drops two long-standing enum annoyances — you cannot remove a value
-- from a Postgres enum, and ALTER TYPE ... ADD VALUE cannot run inside a transaction.
--
-- The CHECK lists must stay in step with the pgEnum declarations in packages/api/src/schema.ts;
-- packages/api/test/schema.test.ts asserts a rejected value for each.

ALTER TABLE shifts ALTER COLUMN status TYPE TEXT USING status::text;
ALTER TABLE shifts ALTER COLUMN status SET DEFAULT 'requested';
ALTER TABLE shifts ADD CONSTRAINT shifts_status_check
  CHECK (status IN ('requested', 'approved', 'rejected'));

ALTER TABLE shifts ALTER COLUMN source TYPE TEXT USING source::text;
ALTER TABLE shifts ALTER COLUMN source SET DEFAULT 'native';
ALTER TABLE shifts ADD CONSTRAINT shifts_source_check
  CHECK (source IN ('native', 'extracted', 'imported'));

ALTER TABLE daily_revenue ALTER COLUMN source TYPE TEXT USING source::text;
ALTER TABLE daily_revenue ALTER COLUMN source SET DEFAULT 'manual';
ALTER TABLE daily_revenue ADD CONSTRAINT daily_revenue_source_check
  CHECK (source IN ('manual', 'extracted'));

ALTER TABLE daily_revenue ALTER COLUMN status TYPE TEXT USING status::text;
ALTER TABLE daily_revenue ALTER COLUMN status SET DEFAULT 'approved';
ALTER TABLE daily_revenue ADD CONSTRAINT daily_revenue_status_check
  CHECK (status IN ('pending', 'needs_review', 'approved', 'rejected'));

ALTER TABLE extraction_jobs ALTER COLUMN doc_type TYPE TEXT USING doc_type::text;
ALTER TABLE extraction_jobs ADD CONSTRAINT extraction_jobs_doc_type_check
  CHECK (doc_type IN ('revenue', 'schedule'));

ALTER TABLE extraction_jobs ALTER COLUMN status TYPE TEXT USING status::text;
ALTER TABLE extraction_jobs ALTER COLUMN status SET DEFAULT 'processing';
ALTER TABLE extraction_jobs ADD CONSTRAINT extraction_jobs_status_check
  CHECK (status IN ('processing', 'needs_review', 'approved', 'rejected'));

-- The enum types are now unused. Dropped so nothing can accidentally depend on them again.
DROP TYPE IF EXISTS shift_status;
DROP TYPE IF EXISTS shift_source;
DROP TYPE IF EXISTS revenue_source;
DROP TYPE IF EXISTS revenue_status;
DROP TYPE IF EXISTS doc_type;
DROP TYPE IF EXISTS extraction_status;
