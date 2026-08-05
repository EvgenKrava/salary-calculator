import './pill.css';

const LABEL: Record<string, string> = {
  requested: 'requested',
  approved: 'approved',
  rejected: 'rejected',
  needs_review: 'needs review',
  processing: 'processing',
  blocked: 'blocked',
};

/**
 * Status is always a word plus a colour, never a colour alone — required for
 * accessibility, and these screens get printed.
 */
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill--${status}`}>{LABEL[status] ?? status}</span>;
}
