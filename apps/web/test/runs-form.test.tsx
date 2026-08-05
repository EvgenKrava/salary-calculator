import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * End-to-end (mocked-hook) tests for the salary-run form.
 *
 * The bug these exist for: the form collected only year/month/half, so `bonuses` was never
 * sent and every run paid 0 bonus for everyone — with no way to correct it, since a run is a
 * final immutable record. A unit test of `parseBonuses` would not have caught that, because
 * the parser was never wired to the payload. These assert the actual mutation argument.
 */

const mutateAsync = vi.fn();
const employeesQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const locationsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const runsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useCreateSalaryRun: () => ({ mutateAsync, isPending: false }),
  useEmployees: () => employeesQuery,
  useLocations: () => locationsQuery,
  useSalaryRuns: () => runsQuery,
}));

const { RunsRoute } = await import('../src/routes/RunsRoute');
const { t } = await import('../src/lib/i18n');

const EMPLOYEES = [
  { id: 'e1', name: 'Olena', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e2', name: 'Taras', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e3', name: 'Former Staff', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: false },
];

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ lines: [] });
  employeesQuery.data = EMPLOYEES;
  employeesQuery.isLoading = false;
  employeesQuery.error = null;
  locationsQuery.data = [];
  locationsQuery.error = null;
  runsQuery.data = [];
  runsQuery.error = null;
});

describe('salary run form — bonuses', () => {
  it('offers a bonus field for every ACTIVE employee, and not for inactive ones', () => {
    render(<RunsRoute />);
    expect(screen.getByLabelText(t.runs.bonusFor('Olena'))).toBeInTheDocument();
    expect(screen.getByLabelText(t.runs.bonusFor('Taras'))).toBeInTheDocument();
    // Paying someone who no longer works here should not even be offered.
    expect(screen.queryByLabelText(t.runs.bonusFor('Former Staff'))).not.toBeInTheDocument();
  });

  it('sends the entered bonuses with the run', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.type(screen.getByLabelText(t.runs.bonusFor('Olena')), '500');
    await user.click(screen.getByRole('button', { name: t.runs.run }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ bonuses: { e1: 500 } });
  });

  it('sends an empty bonuses object when none are entered, never omitting the field', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.click(screen.getByRole('button', { name: t.runs.run }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].bonuses).toEqual({});
  });

  it('refuses to run and names the employee when a bonus is not a valid amount', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.type(screen.getByLabelText(t.runs.bonusFor('Taras')), 'abc');
    await user.click(screen.getByRole('button', { name: t.runs.run }));

    expect(await screen.findByText(t.runs.badBonus('Taras'))).toBeInTheDocument();
    // A run is immutable once created — it must not be sent with a bad bonus silently dropped.
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('refuses to run when the year is cleared, instead of sending 0', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.clear(screen.getByLabelText(t.runs.year));
    await user.click(screen.getByRole('button', { name: t.runs.run }));

    expect(await screen.findByText(t.runs.badYear)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('blocks the run and explains why when employees cannot be loaded', async () => {
    // Rendering an empty bonus list here would make a manager believe there was nothing to
    // enter, and the run would silently pay no bonuses.
    employeesQuery.data = [];
    employeesQuery.error = new Error('403 forbidden');
    render(<RunsRoute />);

    expect(screen.getByText(t.runs.employeesFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.runs.run })).toBeDisabled();
  });
});
