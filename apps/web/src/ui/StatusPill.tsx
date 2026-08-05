import './pill.css';
import { t } from '../lib/i18n';

// KEYS are API enum values and must stay English — VALUES are what the user reads.
const LABEL: Record<string, string> = {
  requested: t.shifts.requested,
  approved: t.shifts.approved,
  rejected: t.shifts.rejected,
  needs_review: t.common.statusNeedsReview,
  processing: t.common.statusProcessing,
  blocked: t.common.statusBlocked,
  // Employee record state. Distinct from approved/rejected on purpose: an inactive employee
  // is not a rejected one, and reusing those styles would read as a decision about them.
  active: t.employees.active,
  inactive: t.employees.inactive,
};

/**
 * Status is always a word plus a colour, never a colour alone — required for
 * accessibility, and these screens get printed.
 */
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill--${status}`}>{LABEL[status] ?? status}</span>;
}
