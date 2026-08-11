import { t } from '../lib/i18n';
import { LoadFailure } from './LoadFailure';

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
  if (anyLoading(...queries)) return <Loading what={what} />;
  const err = firstError(...queries);
  if (err) return <LoadFailure what={what} error={err} />;
  return <>{children()}</>;
}

/**
 * The one loading indicator: a small inline mono line, per docs/design/system.md § Motion —
 * "no skeleton shimmer … use a small inline mono `loading…`".
 *
 * `role="status"` because a screen that swaps its whole body for one word is exactly the case a
 * screen reader needs told; every route was rendering this line bare. `what` names what is being
 * waited for, so four panels loading on one Setup screen are distinguishable rather than four
 * identical "завантаження…" lines.
 */
export function Loading({ what }: { what?: string }) {
  return (
    <p className="mono loading" role="status">
      {/* The word and the subject are separate elements so `t.common.loading` stays its own text
          node — the schedule-grid and pay-matrix tests query for it exactly, and they are pinning
          that no cell is writable while a gate is open, which is behaviour worth keeping pinned. */}
      <span>{t.common.loading}</span>
      {what ? <span> {what}</span> : null}
    </p>
  );
}
