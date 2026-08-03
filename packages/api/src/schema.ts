// This Drizzle schema is for query building only. CHECK constraints
// (rate_per_hour >= 0, standard_shift_hours > 0, revenue_percent in [0,1], amount >= 0)
// are defined and enforced in packages/core/db/migrations/0001_init.sql, the source of truth.
import {
  boolean,
  date,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const shiftStatus = pgEnum('shift_status', ['requested', 'approved', 'rejected']);
export const shiftSource = pgEnum('shift_source', ['native', 'extracted']);
export const revenueSource = pgEnum('revenue_source', ['manual', 'extracted']);
export const revenueStatus = pgEnum('revenue_status', ['pending', 'needs_review', 'approved', 'rejected']);
export const docType = pgEnum('doc_type', ['revenue', 'schedule']);
export const extractionStatus = pgEnum('extraction_status', ['processing', 'needs_review', 'approved', 'rejected']);

export const levels = pgTable('levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ratePerHour: numeric('rate_per_hour', { precision: 10, scale: 2 }).notNull(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  standardShiftHours: numeric('standard_shift_hours', { precision: 5, scale: 2 }).notNull(),
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
    status: shiftStatus('status').notNull().default('requested'),
    source: shiftSource('source').notNull().default('native'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.employeeId, t.workDate)],
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