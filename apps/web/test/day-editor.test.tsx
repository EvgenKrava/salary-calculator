import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

/** The assign body, typed so `mock.calls[0][0]` is inspectable without casting. */
type AssignBody = {
  employeeId: string;
  locationId: string;
  workDate: string;
  startsAt?: string;
  endsAt?: string;
};

const assign = { mutateAsync: vi.fn(async (_body: AssignBody) => ({})), isPending: false };
const remove = { mutateAsync: vi.fn(async (_id: string) => ({})), isPending: false };
const slotsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useAssignShift: () => assign,
  useDeleteShift: () => remove,
  useShiftSlots: () => slotsQuery,
}));

const { DayEditor } = await import('../src/routes/DayEditor');

const LOCATIONS = [
  { id: 'l1', name: 'Перша', opensAt: '08:00', closesAt: '20:00' },
  { id: 'l2', name: 'Друга', opensAt: '09:00', closesAt: '21:00' },
];
const EMPLOYEES = [
  { id: 'e1', name: 'Олена', levelId: 'lv1', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e2', name: 'Ігор', levelId: 'lv1', revenuePercent: 0, cognitoSub: null, active: false },
];

function renderEditor(shifts: unknown[] = []) {
  return render(
    <DayEditor
      date="2026-05-14"
      shifts={shifts as never}
      employees={EMPLOYEES as never}
      locations={LOCATIONS as never}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  assign.mutateAsync.mockClear();
  assign.isPending = false;
  remove.mutateAsync.mockClear();
  remove.isPending = false;
  slotsQuery.data = [];
});

/**
 * Manual shift entry.
 *
 * The schedule was read-only, so the only route into the app was a workbook import — and the
 * importer deliberately refuses to guess. On the real client file that leaves 148 *substitutions*
 * (a covering person's name written where a location number belongs) parsed, reported, and never
 * imported: those people worked and would not be paid. This screen is the fix.
 */
describe('DayEditor', () => {
  it('assigns a shift for the day it was opened on', async () => {
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(t.common.employee), 'e1');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));

    expect(assign.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', locationId: 'l1', workDate: '2026-05-14' }),
    );
  });

  it('omits the window when no slot is chosen, so the API applies the location hours', async () => {
    // Sending '' would be rejected by the API's schema; omitting is what triggers the fallback.
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(t.common.employee), 'e1');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));

    const body = assign.mutateAsync.mock.calls[0][0];
    expect(body.startsAt).toBeUndefined();
    expect(body.endsAt).toBeUndefined();
  });

  it('sends the chosen slot window', async () => {
    slotsQuery.data = [{ locationId: 'l1', slotNumber: 2, startsAt: '14:00', endsAt: '20:00' }];
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(t.common.employee), 'e1');
    await userEvent.selectOptions(screen.getByLabelText(t.dayEditor.window), '2');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));

    expect(assign.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ startsAt: '14:00', endsAt: '20:00' }),
    );
  });

  it('refuses to submit without an employee rather than sending a blank id', async () => {
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));
    expect(assign.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(t.dayEditor.chooseEmployee)).toBeInTheDocument();
  });

  it('offers only active employees — an inactive one cannot be scheduled', async () => {
    renderEditor();
    const select = screen.getByLabelText(t.common.employee);
    expect(select).toHaveTextContent('Олена');
    expect(select).not.toHaveTextContent('Ігор');
  });

  it('clears the slot when the location changes, so a stale window is never applied', async () => {
    // Slot numbers are per-location: slot 2 at Перша is a different window from slot 2 at Друга.
    slotsQuery.data = [{ locationId: 'l1', slotNumber: 2, startsAt: '14:00', endsAt: '20:00' }];
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(t.common.employee), 'e1');
    await userEvent.selectOptions(screen.getByLabelText(t.dayEditor.window), '2');
    await userEvent.selectOptions(screen.getByLabelText(t.common.location), 'l2');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));

    const body = assign.mutateAsync.mock.calls[0][0];
    expect(body.locationId).toBe('l2');
    expect(body.startsAt).toBeUndefined();
  });

  it('surfaces the API error instead of silently failing', async () => {
    assign.mutateAsync.mockRejectedValueOnce(new Error('overlaps an existing approved shift'));
    renderEditor();
    await userEvent.selectOptions(screen.getByLabelText(t.common.employee), 'e1');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.add }));
    expect(await screen.findByText('overlaps an existing approved shift')).toBeInTheDocument();
  });

  it('lists existing shifts with a remove action', async () => {
    renderEditor([
      {
        id: 's1',
        employeeId: 'e1',
        locationId: 'l1',
        workDate: '2026-05-14',
        startsAt: '08:00',
        endsAt: '14:00',
        status: 'approved',
        source: 'imported',
      },
    ]);
    // Scoped to the list: "Олена" also appears as an <option> in the add form's employee select.
    expect(screen.getByRole('listitem')).toHaveTextContent('Олена');
    expect(screen.getByRole('listitem')).toHaveTextContent('08:00–14:00');
    await userEvent.click(screen.getByRole('button', { name: t.dayEditor.removeShiftFor('Олена') }));
    expect(remove.mutateAsync).toHaveBeenCalledWith('s1');
  });

  it('says the day is empty rather than showing a bare form', () => {
    renderEditor();
    expect(screen.getByText(t.dayEditor.noShifts)).toBeInTheDocument();
  });
});
