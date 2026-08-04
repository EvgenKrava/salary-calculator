import type {
  CalcInput,
  CalcResult,
  EmployeeBreakdown,
  PayPeriod,
  RevenueGap,
  Shift,
} from './types';
import { isWithinPeriod } from './payPeriod';
import { hoursBetween } from './time';
import { round2 } from './money';

function dayKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

/**
 * Compute per-employee pay for a pay period.
 *
 * Hourly pay = level rate x actual hours worked (shift end - start), summed over the
 * employee's approved shifts in the period. Revenue share = the employee's revenue
 * fraction x the location-day's approved revenue, prorated by that employee's share of
 * the total hours worked at that location on that day (days are commonly split between
 * people). A worked location-day with no approved revenue is recorded as a gap and marks
 * the result `blocked`.
 */
export function calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult {
  const levelById = new Map(input.levels.map((l) => [l.id, l]));
  const locationById = new Map(input.locations.map((loc) => [loc.id, loc]));

  const revenueByDay = new Map<string, number>();
  for (const r of input.dailyRevenue) {
    if (r.status === 'approved') {
      revenueByDay.set(dayKey(r.locationId, r.revenueDate), r.amount);
    }
  }

  // Only approved, in-period shifts participate — in pay, in gaps, and in the
  // proration denominator.
  const relevant: Shift[] = input.shifts.filter(
    (s) => s.status === 'approved' && isWithinPeriod(s.workDate, period),
  );

  // Pass 1: total hours worked per location-day, across ALL employees. This is the
  // denominator that makes each person's revenue share proportional to their time.
  const totalHoursByDay = new Map<string, number>();
  const hoursByShiftId = new Map<string, number>();
  for (const shift of relevant) {
    if (!locationById.has(shift.locationId)) {
      throw new Error(`Shift ${shift.id} references unknown location ${shift.locationId}`);
    }
    const hours = hoursBetween(shift.startsAt, shift.endsAt);
    hoursByShiftId.set(shift.id, hours);
    const key = dayKey(shift.locationId, shift.workDate);
    totalHoursByDay.set(key, (totalHoursByDay.get(key) ?? 0) + hours);
  }

  const shiftsByEmployee = new Map<string, Shift[]>();
  for (const shift of relevant) {
    const list = shiftsByEmployee.get(shift.employeeId) ?? [];
    list.push(shift);
    shiftsByEmployee.set(shift.employeeId, list);
  }

  const lines: EmployeeBreakdown[] = [];
  const gaps: RevenueGap[] = [];

  // Pass 2: per-employee pay, using the location-day totals from pass 1.
  for (const employee of input.employees) {
    if (!employee.active) continue;

    const level = levelById.get(employee.levelId);
    if (!level) {
      throw new Error(`Employee ${employee.id} references unknown level ${employee.levelId}`);
    }

    const empShifts = shiftsByEmployee.get(employee.id) ?? [];
    let hourlyPay = 0;
    let revenueShare = 0;
    // One gap per employee per location-day, even if they worked it in several shifts.
    const gapDays = new Set<string>();

    for (const shift of empShifts) {
      const hours = hoursByShiftId.get(shift.id)!;
      hourlyPay += level.ratePerHour * hours;

      const key = dayKey(shift.locationId, shift.workDate);
      const revenue = revenueByDay.get(key);
      if (revenue === undefined) {
        if (!gapDays.has(key)) {
          gapDays.add(key);
          gaps.push({ employeeId: employee.id, locationId: shift.locationId, date: shift.workDate });
        }
        continue;
      }
      const totalHours = totalHoursByDay.get(key)!;
      revenueShare += employee.revenuePercent * revenue * (hours / totalHours);
    }

    const roundedHourly = round2(hourlyPay);
    const roundedShare = round2(revenueShare);
    const roundedBonus = round2(input.bonuses[employee.id] ?? 0);
    lines.push({
      employeeId: employee.id,
      hourlyPay: roundedHourly,
      revenueShare: roundedShare,
      bonus: roundedBonus,
      total: round2(roundedHourly + roundedShare + roundedBonus),
    });
  }

  return { period, lines, gaps, blocked: gaps.length > 0 };
}
