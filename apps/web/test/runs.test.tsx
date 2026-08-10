import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { t, formatDate } from '../src/lib/i18n';

// A blocked run's next action is a LINK to the screen that fixes it, so these components pull in
// the router. Stubbed to a plain anchor: what matters here is that the destination is named.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));

const { RunBreakdown, BlockedRun, MissingRates, parseBonuses } = await import('../src/routes/RunsRoute');

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
    // '25.00' appears three times in this fixture: e1's bonus, e2's revenueShare, and the
    // bonus COLUMN TOTAL in the footer (25 + 0). getAllByText, so duplicates aren't failures.
    expect(screen.getAllByText('25.00')).toHaveLength(3);
    expect(screen.getByText('235.00')).toBeInTheDocument();
  });

  it('renders a zero bonus as 0.00, not blank', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('shows a grand total that equals the sum of the lines', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    // Twice: the display figure at the top of the ledger and the footer's total column. The
    // figure is the answer, the footer is the evidence — see docs/design/system.md.
    expect(screen.getAllByText('340.00')).toHaveLength(2);
  });

  it('leads with the payroll total in display numerals', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText(t.runs.payrollTotal)).toBeInTheDocument();
  });

  it('shows the period alongside the display total when one is given', () => {
    render(
      <RunBreakdown lines={LINES} employees={EMPLOYEES} period="05.05.2026 — 04.06.2026" />,
    );
    expect(screen.getByText(/05\.05\.2026 — 04\.06\.2026/)).toBeInTheDocument();
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
    expect(screen.getByText(new RegExp(formatDate('2026-05-03')))).toBeInTheDocument();
    // "revenue" appears in both the heading and the explanatory copy — assert on the worklist
    // text so this checks the blocker names its cause, not just that the word occurs once.
    // The heading must say WHY the run is blocked, not just that it is.
    expect(screen.getByText(t.runs.blockedTitle)).toBeInTheDocument();
  });
});

/**
 * The second blocker: a (level, location) combination with no configured pay.
 *
 * It blocks the run exactly like a revenue gap, and the API already refuses — so what this
 * component owes the manager is the same thing `BlockedRun` owes them: the NAMES of what is
 * wrong, each one a link to where it is fixed. The API sends ids, and a screen reading
 * "lv1 — loc2 is not configured" is a dead end.
 */
describe('missing pay rates', () => {
  const LEVELS = [
    { id: 'lv1', name: 'Бариста' },
    { id: 'lv2', name: 'Старший бариста' },
  ];
  const LOCS = [
    { id: 'l1', name: 'Центр', opensAt: '08:00', closesAt: '20:00' },
    { id: 'l2', name: 'Поділ', opensAt: '09:00', closesAt: '21:00' },
  ];

  it('names the level and the location of every unconfigured cell', () => {
    render(
      <MissingRates
        missing={[
          { levelId: 'lv1', locationId: 'l2' },
          { levelId: 'lv2', locationId: 'l1' },
        ]}
        levels={LEVELS}
        locations={LOCS}
      />,
    );
    expect(screen.getByText(t.payMatrix.missingTitle)).toBeInTheDocument();
    expect(screen.getByText(t.payMatrix.missingHint)).toBeInTheDocument();

    const entries = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(entries[0]).toContain('Бариста');
    expect(entries[0]).toContain('Поділ');
    expect(entries[1]).toContain('Старший бариста');
    expect(entries[1]).toContain('Центр');
    // Ids are an implementation detail; a manager cannot act on one.
    expect(screen.queryByText(/lv1|loc2/)).not.toBeInTheDocument();
  });

  it('links each one to the setup screen where the pay is configured', () => {
    render(
      <MissingRates
        missing={[{ levelId: 'lv1', locationId: 'l2' }]}
        levels={LEVELS}
        locations={LOCS}
      />,
    );
    // A blocked state names the blocker AND links to it — docs/design/system.md § Empty vs
    // blocked. Naming it without the link leaves the manager hunting for the screen.
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/setup');
    expect(link.textContent).toContain('Бариста');
  });
});

describe('bonus parsing', () => {
  it('omits blank fields rather than sending zeros', () => {
    // Blank must mean "no bonus", not an explicit 0 — sending 0 for everyone is harmless
    // today but makes the payload lie about what the manager entered.
    expect(parseBonuses({ e1: '', e2: '   ' })).toEqual({ bonuses: {}, invalid: [] });
  });

  it('parses entered amounts, including decimals', () => {
    expect(parseBonuses({ e1: '500', e2: '12.50' })).toEqual({
      bonuses: { e1: 500, e2: 12.5 },
      invalid: [],
    });
  });

  it('treats an explicit 0 as no bonus', () => {
    expect(parseBonuses({ e1: '0' })).toEqual({ bonuses: {}, invalid: [] });
  });

  it('names the offending employees instead of coercing garbage to a number', () => {
    // Number('abc') is NaN and Number('-5') is negative; both would 400 server-side with no
    // indication of which row was wrong.
    expect(parseBonuses({ e1: 'abc', e2: '-5', e3: '100' })).toEqual({
      bonuses: { e3: 100 },
      invalid: ['e1', 'e2'],
    });
  });
});

describe('breakdown column totals', () => {
  it('totals every component, not just the grand total', () => {
    // A manager reconciles each column against the bank transfer and the revenue figures.
    // With only a grand total they have to add a column by hand — the arithmetic this screen
    // exists to remove.
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    expect(screen.getByText('240.00')).toBeInTheDocument(); // hourly: 160 + 80
    expect(screen.getByText('75.00')).toBeInTheDocument();  // revenue share: 50 + 25
    // Grand total appears twice — display figure plus footer column.
    expect(screen.getAllByText('340.00')).toHaveLength(2);
  });

  it('names how many people are in the run', () => {
    render(<RunBreakdown lines={LINES} employees={EMPLOYEES} />);
    // Twice: beside the display figure, and in the footer's label cell.
    expect(screen.getAllByText(`${t.runs.allEmployees} (2)`)).toHaveLength(2);
  });
});
