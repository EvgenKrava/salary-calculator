/** A pay period, inclusive of both boundary dates ('YYYY-MM-DD'). */
export interface PayPeriod {
  start: string;
  end: string;
}

export type ShiftStatus = 'requested' | 'approved' | 'rejected';
export type ShiftSource = 'native' | 'extracted';
export type RevenueSource = 'manual' | 'extracted';
export type RevenueStatus = 'pending' | 'needs_review' | 'approved' | 'rejected';

export interface Level {
  id: string;
  name: string;
  ratePerHour: number;
}

export interface Location {
  id: string;
  name: string;
  standardShiftHours: number;
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
