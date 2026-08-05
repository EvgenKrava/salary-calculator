import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildMonthGrid, DayCell } from '../src/routes/ScheduleRoute';
import { t } from '../src/lib/i18n';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: unknown; to?: string }) => <a href={to as string}>{children as never}</a>,
}));

const shiftsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const employeesQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const locationsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useShifts: () => shiftsQuery,
  useEmployees: () => employeesQuery,
  useLocations: () => locationsQuery,
}));

const { ScheduleRoute } = await import('../src/routes/ScheduleRoute');

beforeEach(() => {
  for (const q of [shiftsQuery, employeesQuery, locationsQuery]) {
    q.data = [];
    q.isLoading = false;
    q.error = null;
  }
});

/**
 * Grid construction is the part most likely to drift by one day if a real `Date` object ever
 * leaks a local-timezone read — `buildMonthGrid` is tested directly, in isolation from
 * rendering, so a regression shows up as a wrong ISO string rather than a wrong pixel.
 */
describe('buildMonthGrid', () => {
  it('starts the grid on a Monday, per Ukrainian convention', () => {
    // 2026-05-01 is a Friday, so three days (Пн–Чт... actually Пн,Вт,Ср,Чт) from April pad the front.
    const cells = buildMonthGrid(2026, 5);
    expect(cells[0].iso).toBe('2026-04-27'); // the Monday of that week
    expect(cells[0].inMonth).toBe(false);
  });

  it('includes every day of the month, marked inMonth', () => {
    const cells = buildMonthGrid(2026, 5);
    const inMonthIsos = cells.filter((c) => c.inMonth).map((c) => c.iso);
    expect(inMonthIsos[0]).toBe('2026-05-01');
    expect(inMonthIsos[inMonthIsos.length - 1]).toBe('2026-05-31');
    expect(inMonthIsos).toHaveLength(31);
  });

  it('pads the tail so every week is complete, and the total is a multiple of 7', () => {
    const cells = buildMonthGrid(2026, 5);
    expect(cells.length % 7).toBe(0);
  });

  it('handles a month that starts on Monday with no leading padding', () => {
    // 2026-06-01 is a Monday.
    const cells = buildMonthGrid(2026, 6);
    expect(cells[0].iso).toBe('2026-06-01');
    expect(cells[0].inMonth).toBe(true);
  });

  it('handles February in a non-leap year (2026) correctly', () => {
    const cells = buildMonthGrid(2026, 2);
    const inMonthIsos = cells.filter((c) => c.inMonth).map((c) => c.iso);
    expect(inMonthIsos).toHaveLength(28);
    expect(inMonthIsos[inMonthIsos.length - 1]).toBe('2026-02-28');
  });

  it('rolls December into the next year for the trailing pad', () => {
    const cells = buildMonthGrid(2026, 12);
    const last = cells[cells.length - 1];
    expect(last.inMonth).toBe(false);
    expect(last.iso.startsWith('2027-01')).toBe(true);
  });
});

describe('DayCell', () => {
  const nameOf = (id: string) => (id === 'e1' ? 'Olena' : '—');
  const locOf = (id: string) => (id === 'l1' ? 'Центр' : '—');

  it('renders no placeholder text for an empty day — silence, not an error', () => {
    render(
      <DayCell
        cell={{ iso: '2026-05-05', day: 5, inMonth: true }}
        shifts={[]}
        nameOf={nameOf}
        locOf={locOf}
        isToday={false}
      />,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('lists every shift on a busy day, each with a distinct status', () => {
    render(
      <DayCell
        cell={{ iso: '2026-05-05', day: 5, inMonth: true }}
        shifts={[
          { id: 's1', employeeId: 'e1', locationId: 'l1', workDate: '2026-05-05', startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' },
          { id: 's2', employeeId: 'e1', locationId: 'l1', workDate: '2026-05-05', startsAt: '16:00', endsAt: '20:00', status: 'requested', source: 'native' },
        ]}
        nameOf={nameOf}
        locOf={locOf}
        isToday={false}
      />,
    );
    expect(screen.getByText(t.shifts.approved)).toBeInTheDocument();
    expect(screen.getByText(t.shifts.requested)).toBeInTheDocument();
    expect(screen.getAllByText('Olena')).toHaveLength(2);
  });
});

describe('ScheduleRoute', () => {
  it('shows an error instead of a calendar full of blank names when employees fail', () => {
    employeesQuery.error = new Error('403 forbidden');
    render(<ScheduleRoute />);
    expect(screen.getByText('403 forbidden')).toBeInTheDocument();
  });

  it('shows an error when shifts fail, rather than an empty-looking month', () => {
    shiftsQuery.error = new Error('network down');
    render(<ScheduleRoute />);
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('renders the weekday header Monday-first', () => {
    render(<ScheduleRoute />);
    const weekdays = screen.getAllByText(/^(Пн|Вт|Ср|Чт|Пт|Сб|Нд)$/);
    expect(weekdays.map((el) => el.textContent)).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']);
  });

  it('links the import button to /import', () => {
    render(<ScheduleRoute />);
    expect(screen.getByRole('link', { name: t.nav.import })).toHaveAttribute('href', '/import');
  });

  it('places a shift on its own day, identified by employee name', () => {
    const now = new Date();
    const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    shiftsQuery.data = [
      { id: 's1', employeeId: 'e1', locationId: 'l1', workDate: iso, startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native' },
    ];
    employeesQuery.data = [{ id: 'e1', name: 'Olena', levelId: 'l', revenuePercent: 0, cognitoSub: null, active: true }];
    locationsQuery.data = [{ id: 'l1', name: 'Центр', opensAt: '08:00', closesAt: '20:00' }];
    render(<ScheduleRoute />);
    expect(screen.getByText('Olena')).toBeInTheDocument();
    expect(screen.getByText('Центр')).toBeInTheDocument();
  });
});
