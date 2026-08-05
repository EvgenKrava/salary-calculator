const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True if `value` is a valid 'HH:MM' 24-hour time string. */
export function isTimeString(value: string): boolean {
  return TIME_RE.test(value);
}

/** Convert 'HH:MM' to minutes since midnight. Throws if malformed. */
export function parseTime(value: string): number {
  const match = TIME_RE.exec(value);
  if (!match) throw new Error(`Invalid time '${value}': expected 'HH:MM' (24-hour)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Decimal hours between two 'HH:MM' times on the same day.
 * Overnight shifts are out of scope, so the end must be after the start.
 */
export function hoursBetween(startsAt: string, endsAt: string): number {
  const start = parseTime(startsAt);
  const end = parseTime(endsAt);
  if (end <= start) {
    throw new Error(`Invalid shift window ${startsAt}-${endsAt}: end must be after start`);
  }
  return (end - start) / 60;
}

/**
 * Widen an `HH:MM` API time to the `HH:MM:SS` a Postgres `TIME` column needs.
 *
 * **Why this is required, not cosmetic:** the RDS Data API parses parameter values strictly and
 * rejects `'09:00'` for a TIME column with `Parse Error for Time: premature end of input`. PGlite
 * — what every test uses — accepts the short form, so writing a location, shift slot, or shift
 * passed the entire suite and then failed with an opaque 500 against the real database.
 *
 * The API contract stays `HH:MM` in both directions; this widens only on the way into the DB, and
 * routes slice back to `HH:MM` on the way out. Already-widened values pass through unchanged so
 * it is safe to apply twice.
 */
export function toSqlTime(value: string): string {
  // Reject anything that is not a time rather than passing junk to the database, where the
  // failure surfaces as a 500 with no indication of which field was wrong.
  if (/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.test(value)) return value;
  if (!isTimeString(value)) {
    throw new Error(`invalid time '${value}': expected HH:MM`);
  }
  return `${value}:00`;
}
