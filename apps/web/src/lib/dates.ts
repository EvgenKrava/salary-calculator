/**
 * Calendar-date arithmetic, in UTC.
 *
 * These lived privately inside ScheduleRoute; the Today screen needs the same operations, and a
 * second copy of date arithmetic is exactly the kind of duplication that drifts into an
 * off-by-one-day bug on a payroll screen.
 *
 * **Everything here is UTC on purpose.** The API's `DATE` columns (`revenue_date`, `work_date`)
 * are calendar dates with no timezone, so they must be built and compared as UTC — a local-time
 * `new Date('2026-05-05')` renders as the 4th anywhere west of UTC, which on a revenue ledger
 * silently attributes a day's takings to the wrong day.
 */

/** `2026-05-05` for a Date, read in UTC. */
export function isoOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's calendar date as `YYYY-MM-DD`. */
export function todayIso(): string {
  return isoOf(new Date());
}

/**
 * `n` days before the given ISO date (or before today), as `YYYY-MM-DD`.
 *
 * Built via `Date.UTC` from the parsed parts rather than by subtracting milliseconds, so DST
 * transitions cannot shift the result — the arithmetic never touches a local timezone.
 */
export function isoDaysAgo(n: number, from: string = todayIso()): string {
  const [y, m, d] = from.split('-').map(Number);
  return isoOf(new Date(Date.UTC(y, m - 1, d - n)));
}

/**
 * Every calendar date from `from` to `to`, inclusive.
 *
 * Returns `[]` when the range is inverted rather than looping forever — a caller computing
 * bounds from user input should not be able to hang the page.
 */
export function isoRange(from: string, to: string): string[] {
  if (from > to) return [];
  const [y, m, d] = from.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; ; i += 1) {
    const iso = isoOf(new Date(Date.UTC(y, m - 1, d + i)));
    if (iso > to) break;
    out.push(iso);
    // Defensive bound: a malformed `to` cannot spin the loop indefinitely.
    if (out.length > 800) break;
  }
  return out;
}
