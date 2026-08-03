import type {
  CalcInput,
  CalcResult,
  EmployeeBreakdown,
  PayPeriod,
  RevenueGap,
  Shift,
} from './types';
import { isWithinPeriod } from './payPeriod';
import { round2 } from './money';

function revenueKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

/**
 * Compute per-employee pay for a pay period.
 *
 * Hourly pay = level rate x the worked location's standard shift hours, per approved
 * shift in the period. Revenue share = the employee's revenue fraction x the approved
 * daily revenue of each location they worked, on each day they worked it (full amount
 * per employee, never split). A worked day with no approved revenue is recorded as a
 * gap and marks the result `blocked`.
 */
export function calculateSalaries(input: CalcInput, period: PayPeriod): CalcResult {
  const levelById = new Map(input.levels.map((l) => [l.id, l]));
  const locationById = new Map(input.locations.map((loc) => [loc.id, loc]));

  const revenueByKey = new Map<string, number>();
  for (const r of input.dailyRevenue) {
    if (r.status === 'approved') {
      revenueByKey.set(revenueKey(r.locationId, r.revenueDate), r.amount);
    }
  }

  const shiftsByEmployee = new Map<string, Shift[]>();
  for (const s of input.shifts) {
    if (s.status !== 'approved' || !isWithinPeriod(s.workDate, period)) continue;
    const list = shiftsByEmployee.get(s.employeeId) ?? [];
    list.push(s);
    shiftsByEmployee.set(s.employeeId, list);
  }

  const lines: EmployeeBreakdown[] = [];
  const gaps: RevenueGap[] = [];

  for (const employee of input.employees) {
    if (!employee.active) continue;

    const level = levelById.get(employee.levelId);
    if (!level) {
      throw new Error(`Employee ${employee.id} references unknown level ${employee.levelId}`);
    }

    const empShifts = shiftsByEmployee.get(employee.id) ?? [];
    let hourlyPay = 0;
    let revenueShare = 0;

    for (const shift of empShifts) {
      const location = locationById.get(shift.locationId);
      if (!location) {
        throw new Error(`Shift ${shift.id} references unknown location ${shift.locationId}`);
      }
      hourlyPay += level.ratePerHour * location.standardShiftHours;

      const revenue = revenueByKey.get(revenueKey(shift.locationId, shift.workDate));
      if (revenue === undefined) {
        gaps.push({ employeeId: employee.id, locationId: shift.locationId, date: shift.workDate });
      } else {
        revenueShare += employee.revenuePercent * revenue;
      }
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