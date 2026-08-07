// This Drizzle schema is for query building only. CHECK constraints
// (rate_per_day >= 0, revenue_percent in [0,1], amount >= 0, closes_at > opens_at,
// ends_at > starts_at) are defined and enforced in packages/core/db/migrations/
// 0001_init.sql and 0002_hours_model.sql, the source of truth.
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const shiftStatus = pgEnum('shift_status', ['draft', 'requested', 'approved', 'rejected']);
export const shiftSource = pgEnum('shift_source', ['native', 'extracted', 'imported']);
export const revenueSource = pgEnum('revenue_source', ['manual', 'extracted']);
export const revenueStatus = pgEnum('revenue_status', ['pending', 'needs_review', 'approved', 'rejected']);
export const docType = pgEnum('doc_type', ['revenue', 'schedule']);
export const extractionStatus = pgEnum('extraction_status', ['processing', 'needs_review', 'approved', 'rejected']);

export const levels = pgTable('levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ratePerDay: numeric('rate_per_day', { precision: 10, scale: 2 }).notNull(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  levelId: uuid('level_id').notNull().references(() => levels.id),
  revenuePercent: numeric('revenue_percent', { precision: 6, scale: 4 }).notNull().default('0'),
  cognitoSub: text('cognito_sub').unique(),
  active: boolean('active').notNull().default(true),
});

export const shifts = pgTable(
  'shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    workDate: date('work_date').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    status: shiftStatus('status').notNull().default('requested'),
    source: shiftSource('source').notNull().default('native'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.employeeId, t.workDate, t.locationId, t.startsAt)],
);

export const dailyRevenue = pgTable(
  'daily_revenue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    revenueDate: date('revenue_date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    source: revenueSource('source').notNull().default('manual'),
    status: revenueStatus('status').notNull().default('approved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.locationId, t.revenueDate)],
);

export const extractionJobs = pgTable('extraction_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: docType('doc_type').notNull(),
  s3Key: text('s3_key').notNull(),
  status: extractionStatus('status').notNull().default('processing'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  extractedJson: jsonb('extracted_json'),
  reviewedBy: text('reviewed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const salaryRuns = pgTable(
  'salary_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.periodStart, t.periodEnd)],
);

export const salaryRunLines = pgTable(
  'salary_run_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => salaryRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id),
    hourlyPay: numeric('hourly_pay', { precision: 12, scale: 2 }).notNull(),
    revenueShare: numeric('revenue_share', { precision: 12, scale: 2 }).notNull(),
    bonus: numeric('bonus', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [unique().on(t.runId, t.employeeId)],
);

export const locationShiftSlots = pgTable(
  'location_shift_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    slotNumber: integer('slot_number').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.locationId, t.slotNumber)],
);

export const scheduleNameMap = pgTable('schedule_name_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceName: text('source_name').notNull().unique(),
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }),
  ignored: boolean('ignored').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A day an employee asked to have off.
 *
 * `required` blocks publishing until the manager confirms; `preferred` only warns. Recorded by
 * the employee in their cabinet or by an admin on their card — hence `createdBy`.
 */
export const dayOffRequests = pgTable(
  'day_off_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    requestDate: date('request_date').notNull(),
    kind: text('kind').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ oneKindPerDay: unique().on(t.employeeId, t.requestDate) }),
);

/** Months whose schedule is live. A row here closes the employee day-off picker for that month. */
export const schedulePublications = pgTable(
  'schedule_publications',
  {
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    publishedBy: text('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    overrideReason: text('override_reason'),
  },
  (t) => ({ oneRowPerMonth: primaryKey({ columns: [t.year, t.month] }) }),
);

/**
 * Every time publishing proceeded over a required-day-off conflict, and why.
 *
 * `schedule_publications.override_reason` keeps the FIRST publish's reason only, so existing
 * readers of that column are unaffected. Every override — including the first — is also
 * appended here, so this table (not that column) is the complete history for a month.
 */
export const schedulePublicationOverrides = pgTable(
  'schedule_publication_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    monthFk: foreignKey({
      columns: [t.year, t.month],
      foreignColumns: [schedulePublications.year, schedulePublications.month],
    }),
    yearMonthIdx: index('schedule_publication_overrides_year_month_idx').on(t.year, t.month),
  }),
);

/** Single-row standing configuration. */
export const appSettings = pgTable('app_settings', {
  id: boolean('id').primaryKey().default(true),
  requiredDaysOffPerMonth: integer('required_days_off_per_month').notNull().default(2),
  preferredDaysOffPerMonth: integer('preferred_days_off_per_month').notNull().default(4),
});