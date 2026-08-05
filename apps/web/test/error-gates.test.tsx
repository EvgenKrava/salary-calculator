import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { anyLoading, firstError } from '../src/ui/QueryGate';

/**
 * A failed query must never degrade into a screen that looks healthy.
 *
 * Every one of these screens previously gated on `isLoading` alone and then read
 * `.data ?? []`. When a query errored, `data` was `undefined`, the fallback rendered, and the
 * result was indistinguishable from real data: a shifts table with every location showing
 * '—', or a review queue reading "Nothing waiting for review" while its endpoint 404'd. For
 * payroll, a silently-empty screen is worse than an error, because the manager acts on it.
 */

const shiftsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const employeesQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const locationsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const jobsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useShifts: () => shiftsQuery,
  useEmployees: () => employeesQuery,
  useLocations: () => locationsQuery,
  useShiftDecision: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useExtractionJobs: () => jobsQuery,
  useJobDecision: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

const { ShiftsRoute } = await import('../src/routes/ShiftsRoute');
const { ReviewRoute } = await import('../src/routes/ReviewRoute');

const SHIFTS = [
  {
    id: 's1',
    employeeId: 'e1',
    locationId: 'l1',
    workDate: '2026-05-05',
    startsAt: '08:00',
    endsAt: '16:00',
    status: 'approved',
    source: 'native',
  },
];

beforeEach(() => {
  for (const q of [shiftsQuery, employeesQuery, locationsQuery, jobsQuery]) {
    q.data = [];
    q.isLoading = false;
    q.error = null;
  }
});

describe('QueryGate helpers', () => {
  it('reports the first error and wraps a non-Error value', () => {
    expect(firstError({ isLoading: false, error: null })).toBeNull();
    expect(firstError({ isLoading: false, error: new Error('boom') })?.message).toBe('boom');
    expect(firstError({ isLoading: false, error: 'plain string' })?.message).toBe('plain string');
    // Order matters: the first failing query is the one to name.
    expect(
      firstError({ isLoading: false, error: null }, { isLoading: false, error: new Error('second') })?.message,
    ).toBe('second');
  });

  it('reports loading if any query is loading', () => {
    expect(anyLoading({ isLoading: false, error: null })).toBe(false);
    expect(anyLoading({ isLoading: false, error: null }, { isLoading: true, error: null })).toBe(true);
  });
});

describe('ShiftsRoute', () => {
  it('shows an error instead of a table full of blank locations when locations fail', () => {
    shiftsQuery.data = SHIFTS;
    locationsQuery.error = new Error('403 forbidden');
    render(<ShiftsRoute />);

    expect(screen.getByText(/could not load shifts/i)).toBeInTheDocument();
    expect(screen.getByText('403 forbidden')).toBeInTheDocument();
    // The table must not render at all — a half-populated payroll table invites action.
    expect(screen.queryByText('2026-05-05')).not.toBeInTheDocument();
  });

  it('shows an error when employees fail, so names cannot silently read as dashes', () => {
    shiftsQuery.data = SHIFTS;
    employeesQuery.error = new Error('network down');
    render(<ShiftsRoute />);
    expect(screen.getByText(/could not load shifts/i)).toBeInTheDocument();
  });

  it('renders normally when every query succeeds', () => {
    shiftsQuery.data = SHIFTS;
    employeesQuery.data = [{ id: 'e1', name: 'Olena', levelId: 'l', revenuePercent: 0, cognitoSub: null, active: true }];
    locationsQuery.data = [{ id: 'l1', name: 'Downtown', opensAt: '08:00', closesAt: '20:00' }];
    render(<ShiftsRoute />);

    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
    expect(screen.getByText('Olena')).toBeInTheDocument();
    expect(screen.getByText('Downtown')).toBeInTheDocument();
  });
});

describe('ReviewRoute', () => {
  it('distinguishes a failed queue from an empty one', () => {
    jobsQuery.error = new Error('404 not found');
    render(<ReviewRoute />);

    expect(screen.getByText(/could not load the review queue/i)).toBeInTheDocument();
    // The dangerous old behaviour: a broken endpoint reading as a healthy empty queue on the
    // one screen whose job is catching bad data before it becomes payroll.
    expect(screen.queryByText(/nothing waiting for review/i)).not.toBeInTheDocument();
  });

  it('still shows the empty state when the queue is genuinely empty', () => {
    render(<ReviewRoute />);
    expect(screen.getByText(/nothing waiting for review/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  });
});
