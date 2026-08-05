import './pill.css';

const LABEL: Record<string, string> = {
  requested: 'requested',
  approved: 'approved',
  rejected: 'rejected',
  needs_review: 'needs review',
  processing: 'processing',
  blocked: 'blocked',
  // Employee record state. Distinct from approved/rejected on purpose: an inactive employee
  // is not a rejected one, and reusing those styles would read as a decision about them.
  active: 'active',
  inactive: 'inactive',
};

/**
 * Status is always a word plus a colour, never a colour alone — required for
 * accessibility, and these screens get printed.
 */
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill--${status}`}>{LABEL[status] ?? status}</span>;
}
