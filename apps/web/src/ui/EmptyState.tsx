import type { ReactNode } from 'react';

/**
 * An empty state states the next action. A *blocked* state names the blocker — a blocked
 * salary run lists its missing location-days, because that is the manager's next move.
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
    <div className="panel" style={{ padding: 'var(--s8)', textAlign: 'center' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {action ? (
        <p style={{ margin: 'var(--s2) 0 0', color: 'var(--ink-muted)' }}>{action}</p>
      ) : null}
      {children}
    </div>
  );
}
