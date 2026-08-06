import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { t } from '../src/lib/i18n';
import { isoDaysAgo, isoRange, isoOf, todayIso } from '../src/lib/dates';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: unknown; to?: string }) => (
    <a href={to as string}>{children as never}</a>
  ),
}));

type Q = { data: unknown[]; isPending: boolean; error: unknown };
const jobsQuery: Q = { data: [], isPending: false, error: null };
const shiftsQuery: Q = { data: [], isPending: false, error: null };
const revenueQuery: Q = { data: [], isPending: false, error: null };
const locationsQuery: Q = { data: [], isPending: false, error: null };

vi.mock('../src/lib/queries', () => ({
  useExtractionJobs: () => jobsQuery,
  useShifts: () => shiftsQuery,
  useRevenue: () => revenueQuery,
  useLocations: () => locationsQuery,
}));

const { TodayRoute } = await import('../src/routes/TodayRoute');

beforeEach(() => {
  for (const q of [jobsQuery, shiftsQuery, revenueQuery, locationsQuery]) {
    q.data = [];
    q.isPending = false;
    q.error = null;
  }
});

/**
 * The Today screen replaced "Choose a section from the navigation." Its contract is that it
 * answers *what needs me?* — so these tests are about attention items being surfaced and linked,
 * not about layout.
 */
/**
 * Revenue covering every past day in the window, so the missing-days check is satisfied and a
 * test can isolate whatever else it is asserting. An *empty* revenue list is not the quiet
 * baseline it looks like: with no rows at all, all six past days are legitimately missing.
 */
function fullWeekOfRevenue() {
  return isoRange(isoDaysAgo(6), isoDaysAgo(1)).map((d, i) => ({
    id: `r${i}`,
    locationId: 'l1',
    revenueDate: d,
    amount: 100,
    source: 'manual',
    status: 'approved',
  }));
}

describe('Today worklist', () => {
  it('says so explicitly when nothing needs attention', () => {
    revenueQuery.data = fullWeekOfRevenue();
    render(<TodayRoute />);
    expect(screen.getByText(t.today.allClear)).toBeInTheDocument();
  });

  it('does not claim all-clear while the queries are still loading', () => {
    // An optimistic "everything is fine" on a payroll worklist is the wrong default: the manager
    // would act on an all-clear the app has not actually verified.
    revenueQuery.isPending = true;
    render(<TodayRoute />);
    expect(screen.queryByText(t.today.allClear)).not.toBeInTheDocument();
  });

  it('surfaces the review queue and links to it, rather than showing a bare count', () => {
    revenueQuery.data = fullWeekOfRevenue();
    jobsQuery.data = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }];
    render(<TodayRoute />);
    // The item itself is the link — a count the manager then has to go hunting for is worse
    // than no count at all.
    const link = screen.getByRole('link', { name: new RegExp(t.today.reviewQueue(3)) });
    expect(link).toHaveAttribute('href', '/review');
  });

  it('surfaces shifts awaiting a decision', () => {
    revenueQuery.data = fullWeekOfRevenue();
    shiftsQuery.data = [{ id: 's1' }];
    render(<TodayRoute />);
    expect(screen.getByText(t.today.pendingShifts(1))).toBeInTheDocument();
  });

  it('flags days in the window with no revenue recorded', () => {
    // One day of revenue inside a 7-day window leaves 5 gaps: 7 days minus that day, minus
    // today (excluded — the day is not over, so its absence is not yet a gap).
    revenueQuery.data = [
      { id: 'r1', locationId: 'l1', revenueDate: isoDaysAgo(3), amount: 100, source: 'manual', status: 'approved' },
    ];
    render(<TodayRoute />);
    expect(screen.getByText(t.today.missingRevenue(5))).toBeInTheDocument();
  });

  it('never flags today as a missing revenue day', () => {
    // Every past day filled, today deliberately empty → nothing to report. Without the
    // exclusion this screen would cry wolf every single morning before the day's takings exist.
    revenueQuery.data = fullWeekOfRevenue();
    render(<TodayRoute />);
    expect(screen.queryByText(/без даних/)).not.toBeInTheDocument();
    expect(screen.getByText(t.today.allClear)).toBeInTheDocument();
  });

  it('flags every past day when no revenue exists at all', () => {
    // The opposite end of the same rule: 6 past days in a 7-day window, today excluded.
    render(<TodayRoute />);
    expect(screen.getByText(t.today.missingRevenue(6))).toBeInTheDocument();
  });

  it('totals the week revenue', () => {
    revenueQuery.data = [
      { id: 'r1', locationId: 'l1', revenueDate: isoDaysAgo(1), amount: 1200.25, source: 'manual', status: 'approved' },
      { id: 'r2', locationId: 'l1', revenueDate: isoDaysAgo(2), amount: 800.75, source: 'manual', status: 'approved' },
    ];
    render(<TodayRoute />);
    // The display figure and the table's totals row both show it.
    expect(screen.getAllByText('2001.00').length).toBeGreaterThan(0);
  });
});

/**
 * Date arithmetic is the part most likely to produce a silent off-by-one on a payroll screen, so
 * it is tested directly rather than only through the rendered output.
 */
describe('date helpers', () => {
  it('reads a Date as a UTC calendar date', () => {
    // 23:30 UTC — a local-time read west of UTC would give the previous day.
    expect(isoOf(new Date(Date.UTC(2026, 4, 5, 23, 30)))).toBe('2026-05-05');
  });

  it('steps back across a month boundary', () => {
    expect(isoDaysAgo(1, '2026-05-01')).toBe('2026-04-30');
  });

  it('steps back across a year boundary', () => {
    expect(isoDaysAgo(1, '2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(isoDaysAgo(1, '2024-03-01')).toBe('2024-02-29');
  });

  it('builds an inclusive range', () => {
    expect(isoRange('2026-05-01', '2026-05-03')).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
  });

  it('returns an empty range when inverted rather than looping', () => {
    expect(isoRange('2026-05-03', '2026-05-01')).toEqual([]);
  });

  it('spans a month boundary in a range', () => {
    expect(isoRange('2026-04-29', '2026-05-02')).toEqual([
      '2026-04-29',
      '2026-04-30',
      '2026-05-01',
      '2026-05-02',
    ]);
  });

  it('gives a 7-day window when combined with isoDaysAgo(6)', () => {
    expect(isoRange(isoDaysAgo(6), todayIso())).toHaveLength(7);
  });
});
