import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';
import { ApiError } from '../src/lib/api';

const setDayOff = { mutateAsync: vi.fn(async (_b: unknown) => ({})), isPending: false };
const clearDayOff = { mutateAsync: vi.fn(async (_b: unknown) => ({})), isPending: false };
const requestsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const settingsQuery = {
  data: { requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 },
  isLoading: false,
  error: null as unknown,
};
const publicationQuery = { data: { published: false }, isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useDayOffRequests: () => requestsQuery,
  useSetDayOff: () => setDayOff,
  useClearDayOff: () => clearDayOff,
  useAppSettings: () => settingsQuery,
  usePublicationState: () => publicationQuery,
}));

const { DayOffPicker } = await import('../src/routes/DayOffPicker');

beforeEach(() => {
  setDayOff.mutateAsync.mockClear();
  clearDayOff.mutateAsync.mockClear();
  requestsQuery.data = [];
  publicationQuery.data = { published: false };
  settingsQuery.data = { requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 };
});

/**
 * Clicking a day cycles none → preferred → required → none, so one control expresses three
 * states without a separate mode switch.
 */
describe('DayOffPicker', () => {
  it('marks an unmarked day as preferred on first click', async () => {
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' }),
    );
  });

  it('promotes a preferred day to required on the next click', async () => {
    requestsQuery.data = [{ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' }];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ requestDate: '2026-09-05', kind: 'required' }),
    );
  });

  it('clears a required day on the third click', async () => {
    requestsQuery.data = [{ employeeId: 'e1', requestDate: '2026-09-05', kind: 'required' }];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(clearDayOff.mutateAsync).toHaveBeenCalledWith({ employeeId: 'e1', date: '2026-09-05' });
  });

  it('shows how much of each allowance is used', () => {
    requestsQuery.data = [
      { employeeId: 'e1', requestDate: '2026-09-01', kind: 'required' },
      { employeeId: 'e1', requestDate: '2026-09-02', kind: 'preferred' },
    ];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.used(1, 2))).toBeInTheDocument();
    expect(screen.getByText(t.daysOff.used(1, 4))).toBeInTheDocument();
  });

  it('goes read-only once the month is published', async () => {
    publicationQuery.data = { published: true };
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.monthPublished)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(setDayOff.mutateAsync).not.toHaveBeenCalled();
  });

  it('renders the Ukrainian limit-reached copy from the structured 409 body', async () => {
    setDayOff.mutateAsync.mockRejectedValueOnce(
      new ApiError('limit reached: at most 2 required days off per month', 409, {
        error: 'limit reached: at most 2 required days off per month',
        code: 'limit_reached',
        limit: 2,
        kind: 'required',
      }),
    );
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(
      await screen.findByText(t.daysOff.limitReached(2, t.daysOff.requiredShort)),
    ).toBeInTheDocument();
  });

  it('shows an unrelated error message verbatim, not the limit-reached copy', async () => {
    setDayOff.mutateAsync.mockRejectedValueOnce(
      new Error('the schedule for that month is already published'),
    );
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    await userEvent.click(screen.getByRole('button', { name: /(^|\s)5(\s|$)/ }));
    expect(
      await screen.findByText('the schedule for that month is already published'),
    ).toBeInTheDocument();
  });

  it('only counts the displayed month in the allowance', () => {
    // A request in October must not consume September's allowance.
    requestsQuery.data = [
      { employeeId: 'e1', requestDate: '2026-10-01', kind: 'required' },
    ];
    render(<DayOffPicker employeeId="e1" year={2026} month={9} />);
    expect(screen.getByText(t.daysOff.used(0, 2))).toBeInTheDocument();
  });
});
