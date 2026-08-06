import type { ReactNode } from 'react';
import './empty.css';

/**
 * An empty state states the next action. A *blocked* state names the blocker — a blocked
 * salary run lists its missing location-days, because that is the manager's next move.
 *
 * Moved out of inline styles and given a dashed border: a solid filled panel made "no data yet"
 * look like a failed load, whereas a dashed outline reads as a space waiting to be filled.
 */
export function EmptyState({
  title,
  action,
  children,
}: {
  title: string;
  action?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {action ? <p className="empty__action">{action}</p> : null}
      {children}
    </div>
  );
}
