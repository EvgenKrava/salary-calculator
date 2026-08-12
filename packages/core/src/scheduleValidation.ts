import type { LocationStaffing, PayPeriod } from './types';
import { isWithinPeriod } from './payPeriod';

/**
 * The hard gate between an LLM-proposed schedule and a written draft shift.
 *
 * Pure — no database, no clock, no network. This is what stands between an occasionally
 * constraint-violating model response and payroll: every proposed assignment is checked against
 * every hard rule, and only what survives is ever written. An assignment failing more than one
 * rule reports the FIRST rule in the fixed order below, so retries and tests get a deterministic
 * reason rather than whichever check happened to run last.
 */

export interface ProposedAssignment {
  employeeId: string;
  locationId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  slotNumber: number;
}

export interface ValidationContext {
  period: PayPeriod;
  employees: { id: string; active: boolean; maxConsecutiveDays: number; homeLocationIds: string[] }[];
  locations: { id: string; slots: { slotNumber: number; startsAt: string; endsAt: string }[] }[];
  /** Per (location, weekday): people needed per slot. A missing row means 0. */
  staffing: LocationStaffing[];
  requiredDaysOff: { employeeId: string; date: string }[];
  preferredDaysOff: { employeeId: string; date: string }[];
  /** In-period AND boundary-adjacent (before period.start), so consecutive-day counting sees the
   *  run-in from the previous period. */
  approvedShifts: { employeeId: string; locationId: string; workDate: string; startsAt: string; endsAt: string }[];
}

export type RejectionReason =
  | 'unknown_employee'
  | 'inactive_employee'
  | 'unknown_location'
  | 'unknown_slot'
  | 'outside_period'
  | 'required_day_off'
  | 'consecutive_limit'
  | 'duplicate'
  | 'overlaps_approved'
  | 'staffing_exceeded';

export interface RejectedAssignment {
  assignment: ProposedAssignment;
  reason: RejectionReason;
}

export type AssignmentFlag = 'off_home' | 'preferred_day_off';

export interface FlaggedAssignment {
  assignment: ProposedAssignment;
  flag: AssignmentFlag;
}

export interface ValidationResult {
  accepted: ProposedAssignment[];
  rejected: RejectedAssignment[];
  flags: FlaggedAssignment[];
}

/** Half-open overlap: 08:00-14:00 and 14:00-20:00 touch but do not clash. Times are zero-padded
 *  24-hour, so lexicographic comparison on the 'HH:MM' prefix is chronological. */
function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const hhmm = (t: string) => t.slice(0, 5);
  return hhmm(aStart) < hhmm(bEnd) && hhmm(bStart) < hhmm(aEnd);
}

/**
 * Weekday of an ISO date string (0 = Sunday .. 6 = Saturday), matching Postgres's EXTRACT(DOW).
 *
 * Parses the parts and builds a UTC date rather than `new Date(iso)`: a DATE column carries no
 * timezone, and `new Date('2026-09-01')` is UTC midnight, which renders (and reports getDay()) as
 * the previous day anywhere west of UTC.
 */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** One day before `date` ('YYYY-MM-DD'), computed via Date.UTC parts so it never falls prey to
 *  DST or timezone shifts. */
function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}

/** One day after `date` ('YYYY-MM-DD'), same Date.UTC-parts discipline as {@link previousDay}. */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function validateAssignments(
  proposed: ProposedAssignment[],
  ctx: ValidationContext,
): ValidationResult {
  const employeeById = new Map(ctx.employees.map((e) => [e.id, e]));
  const locationById = new Map(ctx.locations.map((l) => [l.id, l]));
  const staffingByKey = new Map(
    ctx.staffing.map((s) => [`${s.locationId}|${s.weekday}`, s.peopleNeeded]),
  );
  const requiredByEmployee = new Map<string, Set<string>>();
  for (const r of ctx.requiredDaysOff) {
    const set = requiredByEmployee.get(r.employeeId) ?? new Set<string>();
    set.add(r.date);
    requiredByEmployee.set(r.employeeId, set);
  }
  const preferredByEmployee = new Map<string, Set<string>>();
  for (const p of ctx.preferredDaysOff) {
    const set = preferredByEmployee.get(p.employeeId) ?? new Set<string>();
    set.add(p.date);
    preferredByEmployee.set(p.employeeId, set);
  }

  // Worked dates per employee, from approved shifts, for the consecutive-run count. Accepted
  // proposals are added to this same structure as the batch is processed, so later proposals see
  // earlier ones in the SAME call (the plan's "already-accepted proposals" rule).
  const workedDatesByEmployee = new Map<string, Set<string>>();
  for (const s of ctx.approvedShifts) {
    const set = workedDatesByEmployee.get(s.employeeId) ?? new Set<string>();
    set.add(s.workDate);
    workedDatesByEmployee.set(s.employeeId, set);
  }

  // Approved shifts grouped for the overlap/duplicate checks below.
  const approvedByEmployeeDate = new Map<string, typeof ctx.approvedShifts>();
  for (const s of ctx.approvedShifts) {
    const key = `${s.employeeId}|${s.workDate}`;
    const list = approvedByEmployeeDate.get(key) ?? [];
    list.push(s);
    approvedByEmployeeDate.set(key, list);
  }

  // Accepted-so-far proposals, keyed the same way, so later proposals in the batch collide with
  // earlier ones exactly like they would with approved shifts.
  const acceptedByEmployeeDate = new Map<string, ProposedAssignment[]>();
  // (employeeId, date, slotNumber) already accepted — the duplicate check.
  const acceptedSlots = new Set<string>();
  // Accepted headcount per (locationId, date, slotNumber) — the staffing check.
  const acceptedHeadcount = new Map<string, number>();

  const accepted: ProposedAssignment[] = [];
  const rejected: RejectedAssignment[] = [];
  const flags: FlaggedAssignment[] = [];

  // Length of the run `date` would join if added to `worked`, counting BOTH directions: a
  // proposal is not only extending a run behind it, it can also bridge into (or between) runs of
  // already-approved shifts that sit AFTER it. A backward-only scan misses that: with
  // maxConsecutiveDays=2 and approved shifts on the 2nd and 3rd, proposing the 1st alone forms a
  // run of three (1st, 2nd, 3rd) even though nothing worked-so-far sits before the 1st.
  function runLengthThrough(employeeId: string, date: string): number {
    const worked = workedDatesByEmployee.get(employeeId);
    if (!worked) return 1;
    let length = 1; // date itself
    let cursor = previousDay(date);
    while (worked.has(cursor)) {
      length += 1;
      cursor = previousDay(cursor);
    }
    cursor = nextDay(date);
    while (worked.has(cursor)) {
      length += 1;
      cursor = nextDay(cursor);
    }
    return length;
  }

  // The consecutive-day check accepts or rejects based on the worked-dates set as it stands as
  // *this* proposal is reached, so that set must fill in chronological order — otherwise a later
  // date processed first would see a run-in that hasn't "happened" yet, or an earlier date
  // processed last could slip past a limit already used up by dates ahead of it. Sorting once,
  // stably, before the loop makes every check's outcome depend only on the proposal set the LLM
  // sent, never on the order it listed them in. Array.prototype.sort is a stable sort (guaranteed
  // since ES2019), so same-date proposals keep the caller's original relative order.
  const sorted = [...proposed].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const a of sorted) {
    const employee = employeeById.get(a.employeeId);
    if (!employee) {
      rejected.push({ assignment: a, reason: 'unknown_employee' });
      continue;
    }
    if (!employee.active) {
      rejected.push({ assignment: a, reason: 'inactive_employee' });
      continue;
    }
    const location = locationById.get(a.locationId);
    if (!location) {
      rejected.push({ assignment: a, reason: 'unknown_location' });
      continue;
    }
    const slot = location.slots.find((s) => s.slotNumber === a.slotNumber);
    if (!slot) {
      rejected.push({ assignment: a, reason: 'unknown_slot' });
      continue;
    }
    if (!isWithinPeriod(a.date, ctx.period)) {
      rejected.push({ assignment: a, reason: 'outside_period' });
      continue;
    }
    if (requiredByEmployee.get(a.employeeId)?.has(a.date)) {
      rejected.push({ assignment: a, reason: 'required_day_off' });
      continue;
    }
    if (runLengthThrough(a.employeeId, a.date) > employee.maxConsecutiveDays) {
      rejected.push({ assignment: a, reason: 'consecutive_limit' });
      continue;
    }

    const slotKey = `${a.employeeId}|${a.date}|${a.slotNumber}`;
    const dateKey = `${a.employeeId}|${a.date}`;
    const alreadyApprovedSameSlot = (approvedByEmployeeDate.get(dateKey) ?? []).some(
      (s) => s.locationId === a.locationId && s.startsAt === slot.startsAt && s.endsAt === slot.endsAt,
    );
    if (acceptedSlots.has(slotKey) || alreadyApprovedSameSlot) {
      rejected.push({ assignment: a, reason: 'duplicate' });
      continue;
    }

    const overlapsApproved = (approvedByEmployeeDate.get(dateKey) ?? []).some((s) =>
      windowsOverlap(slot.startsAt, slot.endsAt, s.startsAt, s.endsAt),
    );
    const overlapsAccepted = (acceptedByEmployeeDate.get(dateKey) ?? []).some((other) => {
      const otherLocation = locationById.get(other.locationId)!;
      const otherSlot = otherLocation.slots.find((s) => s.slotNumber === other.slotNumber)!;
      return windowsOverlap(slot.startsAt, slot.endsAt, otherSlot.startsAt, otherSlot.endsAt);
    });
    if (overlapsApproved || overlapsAccepted) {
      rejected.push({ assignment: a, reason: 'overlaps_approved' });
      continue;
    }

    const weekday = weekdayOf(a.date);
    const peopleNeeded = staffingByKey.get(`${a.locationId}|${weekday}`) ?? 0;
    const headcountKey = `${a.locationId}|${a.date}|${a.slotNumber}`;
    const currentHeadcount = acceptedHeadcount.get(headcountKey) ?? 0;
    if (currentHeadcount + 1 > peopleNeeded) {
      rejected.push({ assignment: a, reason: 'staffing_exceeded' });
      continue;
    }

    // Accepted. Record it everywhere a later proposal in this batch might collide with it.
    accepted.push(a);
    acceptedSlots.add(slotKey);
    acceptedHeadcount.set(headcountKey, currentHeadcount + 1);
    const dateList = acceptedByEmployeeDate.get(dateKey) ?? [];
    dateList.push(a);
    acceptedByEmployeeDate.set(dateKey, dateList);
    const worked = workedDatesByEmployee.get(a.employeeId) ?? new Set<string>();
    worked.add(a.date);
    workedDatesByEmployee.set(a.employeeId, worked);

    if (!employee.homeLocationIds.includes(a.locationId)) {
      flags.push({ assignment: a, flag: 'off_home' });
    }
    if (preferredByEmployee.get(a.employeeId)?.has(a.date)) {
      flags.push({ assignment: a, flag: 'preferred_day_off' });
    }
  }

  return { accepted, rejected, flags };
}
