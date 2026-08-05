import { t } from '../lib/i18n';

/**
 * Loading/error gate for screens that read several queries at once.
 *
 * Gating only on `isLoading` and then reading `.data ?? []` is the bug this prevents: when a
 * query errors, `data` is `undefined`, the fallback renders, and the screen looks *healthy* —
 * a shifts table with every location blanked to '—', or a review queue that reads "Nothing
 * waiting for review" when the endpoint is actually 404ing. For payroll, silently-empty is
 * worse than an error, because the manager acts on it.
 *
 * Use for any screen where a failed sub-query would otherwise degrade into plausible-looking
 * blanks rather than a visible failure.
 */
export interface QueryLike {
  isLoading: boolean;
  error: unknown;
}

/** First error across the given queries, or null. */
export function firstError(...queries: QueryLike[]): Error | null {
  for (const q of queries) {
    if (q.error) return q.error instanceof Error ? q.error : new Error(String(q.error));
  }
  return null;
}

/** True while any query is still loading. */
export function anyLoading(...queries: QueryLike[]): boolean {
  return queries.some((q) => q.isLoading);
}

export function QueryGate({
  queries,
  children,
  what,
}: {
  queries: QueryLike[];
  children: () => React.ReactNode;
  /** What the screen was trying to load, named in the error so the message is actionable. */
  what: string;
}) {
  if (anyLoading(...queries)) return <p className="mono">{t.common.loading}</p>;
  const err = firstError(...queries);
  if (err) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>{t.common.couldNotLoad(what)}</h2>
        <p className="mono" style={{ margin: 0 }}>{err.message}</p>
        <p style={{ marginBottom: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>
          {t.common.reload}
        </p>
      </div>
    );
  }
  return <>{children()}</>;
}
