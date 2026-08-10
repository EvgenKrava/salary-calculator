import type {
  CalcInput,
  CalcResult,
  EmployeeBreakdown,
  MissingRate,
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

function cellKey(levelId: string, locationId: string): string {
  return `${levelId}|${locationId}`;
}

/**
 * Compute per-employee pay for a pay period.
 *
 * **Base pay and revenue percent come from `pay_rates`, a (level, location) matrix** — a level
 * is a pure label; the same level pays a different guaranteed day rate AND a different revenue
 * percent at different locations. Base pay is that cell's day rate, pro-rated by hours actually
 * worked, summed over the employee's approved shifts in the period:
 *
 *     base = cell.rate_per_day x hours(shift) / working_hours(shift.location)
 *
 * A full day pays exactly the day rate; half a day pays half. Pro-rating is required, not a
 * refinement: a day is regularly split between two people ("Буває що не цілий день а декілька
 * годин, а решту допрацьовює інша людина"), and paying each a full day would roughly double
 * that day's wage bill.
 *
 * The divisor is the **shift's own location's** working day, because locations have different
 * opening hours — dividing an 8-hour shift by a 12-hour location and by a 9-hour one must give
 * different pay for the same rate.
 *
 * Revenue share = the cell's revenue fraction x the location-day's approved revenue, prorated by
 * that employee's share of the total hours worked at that location on that day. A worked
 * location-day with no approved revenue is recorded as a gap and marks the result `blocked`.
 *
 * A worked (level, location) with no configured `pay_rates` cell contributes to NEITHER
 * component — writing 0 silently is the one unforgivable failure in a payroll app — and is
 * recorded in `missingRates` instead, which also blocks the result.
 */
export function calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult {
  const levelById = new Map(input.levels.map((l) => [l.id, l]));
  const locationById = new Map(input.locations.map((loc) => [loc.id, loc]));
  const rateByCell = new Map(input.payRates.map((r) => [cellKey(r.levelId, r.locationId), r]));

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
  // (levelId, locationId) cells worked with no pay_rates row. A Set, not a list, because the
  // same missing cell is hit by many shifts/employees and must be reported exactly once.
  const missingCells = new Set<string>();

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
      // Pro-rate the day rate against this location's own working day.
      const location = locationById.get(shift.locationId)!;
      const locationDayHours = hoursBetween(location.opensAt, location.closesAt);
      if (locationDayHours <= 0) {
        // Unreachable via the API (a CHECK enforces closes_at > opens_at) but a zero divisor
        // would silently produce Infinity in someone's pay, so fail loudly instead.
        throw new Error(`Location ${location.id} has a non-positive working day`);
      }

      const cell = rateByCell.get(cellKey(employee.levelId, shift.locationId));
      if (!cell) {
        // No configured pay for this level at this location. This blocks the run — the day
        // rate is the person's base wage, and writing 0 silently is the one unforgivable
        // failure in a payroll app. The shift contributes to NEITHER component and does not
        // create a revenue gap of its own (the run is already blocked; reporting the same
        // shift twice as two kinds of gap is noise). The missing-cell check comes BEFORE the
        // revenue-gap check below, so a missing-cell shift produces exactly one kind of gap.
        missingCells.add(cellKey(employee.levelId, shift.locationId));
        continue;
      }
      hourlyPay += cell.ratePerDay * (hours / locationDayHours);

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
      revenueShare += cell.revenuePercent * revenue * (hours / totalHours);
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

  const missingRates: MissingRate[] = [...missingCells].map((key) => {
    const [levelId, locationId] = key.split('|');
    return { levelId, locationId };
  });

  return { period, lines, gaps, missingRates, blocked: gaps.length > 0 || missingRates.length > 0 };
}
