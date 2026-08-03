import type { PayPeriod } from './types';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The two pay periods for a calendar month: 1st–15th and 16th–end of month.
 * `month` is 1-based (1 = January).
 */
export function payPeriodsForMonth(year: number, month: number): [PayPeriod, PayPeriod] {
  const mm = pad(month);
  // Day 0 of the next month is the last day of this month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    { start: `${year}-${mm}-01`, end: `${year}-${mm}-15` },
    { start: `${year}-${mm}-16`, end: `${year}-${mm}-${pad(lastDay)}` },
  ];
}

/** True if `date` ('YYYY-MM-DD') falls within `period`, inclusive of boundaries. */
export function isWithinPeriod(date: string, period: PayPeriod): boolean {
  return date >= period.start && date <= period.end;
}