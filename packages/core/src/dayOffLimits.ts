/**
 * Day-off request limits and schedule conflicts. Pure — no database, no clock.
 *
 * Kept out of the route handlers because these are the rules a manager and an employee both
 * experience and the ones most worth testing directly: an off-by-one in the monthly count either
 * refuses a legitimate request or lets someone book the whole month off.
 */

export type DayOffKind = 'required' | 'preferred';

export interface DayOffRequestLike {
  /** 'YYYY-MM-DD' */
  requestDate: string;
  kind: DayOffKind;
}

export interface DayOffLimits {
  required: number;
  preferred: number;
}

/**
 * Month of an ISO date, compared as a string prefix.
 *
 * String comparison rather than `new Date(iso)`: a DATE column carries no timezone, and
 * constructing a Date parses it as UTC midnight which renders as the previous day anywhere west
 * of UTC — a request for the 1st would be counted against the previous month.
 */
function monthPrefix(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** How many requests of each kind fall in the given calendar month. */
export function countInMonth(
  requests: DayOffRequestLike[],
  year: number,
  month: number,
): DayOffLimits {
  const prefix = monthPrefix(year, month);
  let required = 0;
  let preferred = 0;
  for (const r of requests) {
    if (!r.requestDate.startsWith(prefix)) continue;
    if (r.kind === 'required') required += 1;
    else preferred += 1;
  }
  return { required, preferred };
}

/**
 * Whether one more request of `kind` fits within the limits for the month `date` falls in.
 *
 * Enforced on write, not at publish time: the person choosing should get the feedback, rather
 * than the manager discovering it weeks later while building the schedule.
 */
export function canAdd(
  existing: DayOffRequestLike[],
  date: string,
  kind: DayOffKind,
  limits: DayOffLimits,
): { ok: true } | { ok: false; reason: 'limit_reached'; kind: DayOffKind; limit: number } {
  const [yearText, monthText] = date.split('-');
  const counts = countInMonth(existing, Number(yearText), Number(monthText));
  const limit = kind === 'required' ? limits.required : limits.preferred;
  // >= because `counts` excludes the request being added.
  if (counts[kind] >= limit) return { ok: false, reason: 'limit_reached', kind, limit };
  return { ok: true };
}

export interface ShiftLike {
  employeeId: string;
  workDate: string;
}

/**
 * Split shifts by whether they land on a day the employee asked off.
 *
 * `required` conflicts block publishing until the manager confirms with a reason; `preferred`
 * ones only warn. Both are returned so the publish screen can state them separately — a manager
 * who cannot tell the two apart will treat every warning as noise.
 */
export function classifyConflicts(
  shifts: ShiftLike[],
  requestsByEmployee: Map<string, DayOffRequestLike[]>,
): { required: ShiftLike[]; preferred: ShiftLike[] } {
  const required: ShiftLike[] = [];
  const preferred: ShiftLike[] = [];
  for (const shift of shifts) {
    const requests = requestsByEmployee.get(shift.employeeId);
    if (!requests) continue;
    const match = requests.find((r) => r.requestDate === shift.workDate);
    if (!match) continue;
    if (match.kind === 'required') required.push(shift);
    else preferred.push(shift);
  }
  return { required, preferred };
}

export interface ShiftWindowLike extends ShiftLike {
  /** 'HH:MM' or 'HH:MM:SS' — a TIME column returns seconds, the API's DTOs trim them. */
  startsAt: string;
  endsAt: string;
}

/**
 * Employee-days where publishing would leave one person working two overlapping windows.
 *
 * This is the double-pay guard. Two approved shifts for the same person in overlapping hours pay
 * the same hours twice — measured on a 600.00/day level, one 6-hour shift priced 300.00 and a
 * duplicated pair priced 600.00 — and they also inflate the proration denominator at whichever
 * location they claim to also be working, underpaying everyone else on that day.
 *
 * Checked at publish time as well as on write, because `assertNoOverlap` on assign is
 * 'approved'-only by design: two DRAFTS in the same window pass every check on the way in, and the
 * flip to 'approved' is the moment they become payable. `candidates` collide with each other as
 * well as with `existing`, since a month's drafts are flipped together.
 *
 * Comparison is half-open, matching assertNoOverlap: 08:00-14:00 and 14:00-20:00 are a split day,
 * not a clash. One entry per employee-day, because the manager needs to know which day to fix
 * rather than how many rows are involved.
 */
export function findOverlaps(
  candidates: ShiftWindowLike[],
  existing: ShiftWindowLike[],
): ShiftLike[] {
  // Times are zero-padded 24-hour, so lexicographic comparison IS chronological — the same reason
  // the route-level checks slice to HH:MM rather than parsing to minutes.
  const hhmm = (t: string) => t.slice(0, 5);
  const found = new Map<string, ShiftLike>();

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    // Every later candidate, plus everything already on the books for that person and day.
    const others = [
      ...candidates.slice(i + 1),
      ...existing.filter((e) => e.employeeId === a.employeeId && e.workDate === a.workDate),
    ];
    for (const b of others) {
      if (b.employeeId !== a.employeeId || b.workDate !== a.workDate) continue;
      if (hhmm(a.startsAt) < hhmm(b.endsAt) && hhmm(b.startsAt) < hhmm(a.endsAt)) {
        found.set(`${a.employeeId}|${a.workDate}`, {
          employeeId: a.employeeId,
          workDate: a.workDate,
        });
      }
    }
  }
  return [...found.values()];
}
