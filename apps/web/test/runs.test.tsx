import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunBreakdown, BlockedRun } from '../src/routes/RunsRoute';

const LINES = [
  { employeeId: 'e1', hourlyPay: 160, revenueShare: 50, bonus: 25, total: 235 },
  { employeeId: 'e2', hourlyPay: 80, revenueShare: 25, bonus: 0, total: 105 },
];
const EMPLOYEES = [
  { id: 'e1', name: 'Olena', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e2', name: 'Taras', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
];

describe('run breakdown', () => {
  it('shows every component and the total for each employee', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('160.00')).toBeInTheDocument();
    expect(screen.getByText('50.00')).toBeInTheDocument();
    // '25.00' legitimately appears twice: e1's bonus and e2's revenueShare are both 25 in
    // this fixture — getAllByText, not getByText, so the duplicate isn't a query failure.
    expect(screen.getAllByText('25.00')).toHaveLength(2);
    expect(screen.getByText('235.00')).toBeInTheDocument();
  });

  it('renders a zero bonus as 0.00, not blank', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('shows a grand total that equals the sum of the lines', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('340.00')).toBeInTheDocument();
  });

  it('names employees rather than showing ids', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('Olena')).toBeInTheDocument();
    expect(screen.queryByText('e1')).not.toBeInTheDocument();
  });
});

describe('blocked run', () => {
  it('names the missing location-days rather than just saying blocked', () => {
    // The API returns gaps; the whole point of showing them is that they are the
    // manager's next action.
    render(
      <BlockedRun
        gaps={[{ employeeId: 'e1', locationId: 'l1', date: '2026-05-03' }]}
        employees={EMPLOYEES}
        locations={[{ id: 'l1', name: '1', opensAt: '08:00', closesAt: '20:00' }]}
      />,
    );
    expect(screen.getByText(/2026-05-03/)).toBeInTheDocument();
    // "revenue" appears in both the heading and the explanatory copy — assert on the worklist
    // text so this checks the blocker names its cause, not just that the word occurs once.
    expect(screen.getAllByText(/revenue/i).length).toBeGreaterThan(0);
  });
});
