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
