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
const previewAsync = vi.fn();
const employeesQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const locationsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const runsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useCreateSalaryRun: () => ({ mutateAsync, isPending: false }),
  useSalaryRunPreview: () => ({ mutateAsync: previewAsync, isPending: false }),
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
  previewAsync.mockReset();
  previewAsync.mockResolvedValue({
    periodStart: '2026-08-01', periodEnd: '2026-08-15', lines: [], gaps: [], blocked: false,
  });
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
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));

    await waitFor(() => expect(previewAsync).toHaveBeenCalled());
    expect(previewAsync.mock.calls[0][0]).toMatchObject({ bonuses: { e1: 500 } });
  });

  it('sends an empty bonuses object when none are entered, never omitting the field', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));
    await waitFor(() => expect(previewAsync).toHaveBeenCalled());
    expect(previewAsync.mock.calls[0][0].bonuses).toEqual({});
  });

  it('refuses to run and names the employee when a bonus is not a valid amount', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.type(screen.getByLabelText(t.runs.bonusFor('Taras')), 'abc');
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));

    expect(await screen.findByText(t.runs.badBonus('Taras'))).toBeInTheDocument();
    // A run is immutable once created — it must not be sent with a bad bonus silently dropped.
    expect(previewAsync).not.toHaveBeenCalled();
  });

  it('refuses to run when the year is cleared, instead of sending 0', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.clear(screen.getByLabelText(t.runs.year));
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));

    expect(await screen.findByText(t.runs.badYear)).toBeInTheDocument();
    expect(previewAsync).not.toHaveBeenCalled();
  });

  it('blocks the run and explains why when employees cannot be loaded', async () => {
    // Rendering an empty bonus list here would make a manager believe there was nothing to
    // enter, and the run would silently pay no bonuses.
    employeesQuery.data = [];
    employeesQuery.error = new Error('403 forbidden');
    render(<RunsRoute />);

    expect(screen.getByText(t.runs.employeesFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.runs.calculate })).toBeDisabled();
  });
});

describe('preview before commit', () => {
  it('does not commit until the manager has seen the figures', async () => {
    // A run is final and immediately visible to employees. The commit button must not exist
    // before a preview, or the flow is still "submit and find out".
    const user = userEvent.setup();
    render(<RunsRoute />);
    expect(screen.queryByRole('button', { name: t.runs.confirmRun })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t.runs.calculate }));
    await waitFor(() => expect(previewAsync).toHaveBeenCalled());

    expect(await screen.findByRole('button', { name: t.runs.confirmRun })).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled(); // previewing must not write
  });

  it('commits exactly the inputs that were previewed', async () => {
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.type(screen.getByLabelText(t.runs.bonusFor('Olena')), '500');
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));
    await user.click(await screen.findByRole('button', { name: t.runs.confirmRun }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ bonuses: { e1: 500 } });
  });

  it('withdraws the commit button when an input changes after previewing', async () => {
    // Otherwise the manager reads one set of numbers, edits a bonus, and commits a different
    // set — the precise mistake this two-step flow exists to prevent.
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));
    expect(await screen.findByRole('button', { name: t.runs.confirmRun })).toBeInTheDocument();

    await user.type(screen.getByLabelText(t.runs.bonusFor('Taras')), '250');

    expect(screen.queryByRole('button', { name: t.runs.confirmRun })).not.toBeInTheDocument();
    expect(screen.getByText(t.runs.staleReview)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the revenue gaps instead of a breakdown when the period is blocked', async () => {
    previewAsync.mockResolvedValueOnce({
      periodStart: '2026-08-01', periodEnd: '2026-08-15', lines: [], blocked: true,
      gaps: [{ employeeId: 'e1', locationId: 'l1', date: '2026-08-03' }],
    });
    const user = userEvent.setup();
    render(<RunsRoute />);
    await user.click(screen.getByRole('button', { name: t.runs.calculate }));

    expect(await screen.findByText(t.runs.blockedTitle)).toBeInTheDocument();
    // No commit path out of a blocked preview.
    expect(screen.queryByRole('button', { name: t.runs.confirmRun })).not.toBeInTheDocument();
  });
});
