/**
 * Shift length in hours, formatted for display.
 *
 * Mirrors `hoursBetween` in `@salary/core/time`, deliberately duplicated rather than imported:
 * `@salary/core` is not a dependency of the web app, and its entry point pulls in Node-only
 * modules (`migrations.ts` reads from `fs`), which would break the browser bundle. Keeping one
 * copy *here* is the point — it previously existed twice, byte-identical, in ShiftsRoute and
 * MyShiftsRoute, so a fix to one would have silently missed the other.
 *
 * The API guarantees whole-minute `HH:MM` windows with `ends_at > starts_at` (enforced by CHECK
 * constraints in migration 0002), so no wrap-around or negative case is handled here.
 */
export function shiftHours(startsAt: string, endsAt: string): string {
  const [sh, sm] = startsAt.split(':').map(Number);
  const [eh, em] = endsAt.split(':').map(Number);
  return ((eh * 60 + em - (sh * 60 + sm)) / 60).toFixed(2);
}
