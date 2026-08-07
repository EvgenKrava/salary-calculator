/** A pay period, inclusive of both boundary dates ('YYYY-MM-DD'). */
export interface PayPeriod {
  start: string;
  end: string;
}

export type ShiftStatus = 'draft' | 'requested' | 'approved' | 'rejected';
export type ShiftSource = 'native' | 'extracted' | 'imported';
export type RevenueSource = 'manual' | 'extracted';
export type RevenueStatus = 'pending' | 'needs_review' | 'approved' | 'rejected';

export interface Level {
  id: string;
  name: string;
  ratePerDay: number;
}

export interface Location {
  id: string;
  name: string;
  /** Location working hours, 'HH:MM'. Used as the default shift window. */
  opensAt: string;
  closesAt: string;
}

export interface Employee {
  id: string;
  name: string;
  levelId: string;
  /** Fraction in [0, 1]; 0.05 = 5%. */
  revenuePercent: number;
  cognitoSub: string | null;
  active: boolean;
}

export interface Shift {
  id: string;
  employeeId: string;
  locationId: string;
  workDate: string; // 'YYYY-MM-DD'
  /** Shift window, 'HH:MM'. Hours worked is the difference. */
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  source: ShiftSource;
}

export interface DailyRevenue {
  locationId: string;
  revenueDate: string; // 'YYYY-MM-DD'
  amount: number;
  status: RevenueStatus;
}

export interface EmployeeBreakdown {
  employeeId: string;
  hourlyPay: number;
  revenueShare: number;
  bonus: number;
  total: number;
}

/**
 * A worked (location, date) that has no approved revenue. One entry is
 * produced per affected employee; a consumer wanting unique (location, date)
 * must dedupe on those two fields.
 */
export interface RevenueGap {
  employeeId: string;
  locationId: string;
  date: string;
}

export interface CalcInput {
  employees: Employee[];
  levels: Level[];
  locations: Location[];
  shifts: Shift[];
  dailyRevenue: DailyRevenue[];
  /** employeeId -> personal bonus amount for this run. */
  bonuses: Record<string, number>;
}

export interface CalcResult {
  period: PayPeriod;
  lines: EmployeeBreakdown[];
  gaps: RevenueGap[];
  blocked: boolean;
}
