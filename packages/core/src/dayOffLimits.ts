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
