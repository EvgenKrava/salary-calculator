import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

const fn = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false });
const addLocation = fn();
const addLevel = fn();
const updateLocation = fn();
const deleteLocation = fn();
const updateLevel = fn();
const deleteLevel = fn();
const setSlot = fn();
const deleteSlot = fn();
const slotsQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  // Stable instances, not a fresh `fn()` per render: the add forms are asserted against now, and
  // a new mock each call would forget what the form submitted.
  useAddLocation: () => addLocation,
  useAddLevel: () => addLevel,
  useLocations: () => ({ data: [], isLoading: false, error: null }),
  useLevels: () => ({ data: [], isLoading: false, error: null }),
  useUpdateLocation: () => updateLocation,
  useDeleteLocation: () => deleteLocation,
  useUpdateLevel: () => updateLevel,
  useDeleteLevel: () => deleteLevel,
  useShiftSlots: () => slotsQuery,
  useSetShiftSlot: () => setSlot,
  useDeleteShiftSlot: () => deleteSlot,
}));

const { SlotEditor } = await import('../src/routes/SlotEditor');
const { LocationRow, LevelRow, LocationsPanel, LevelsPanel } = await import('../src/routes/SetupRoute');

const LOCATION = { id: 'l1', name: 'Перша', opensAt: '08:00', closesAt: '20:00' };

beforeEach(() => {
  for (const m of [addLocation, addLevel, updateLocation, deleteLocation, updateLevel, deleteLevel, setSlot, deleteSlot]) {
    m.mutateAsync.mockReset();
    m.mutateAsync.mockImplementation(async () => ({}));
    m.isPending = false;
  }
  slotsQuery.data = [];
  slotsQuery.isLoading = false;
});

/**
 * Shift-slot windows.
 *
 * These had a complete API and NO UI, which is why the deployed locations still run on placeholder
 * 09:00–21:00 hours. They are a payroll input, not configuration trivia: an imported shift takes
 * its hours from the matching slot window, and a day rate is pro-rated against the location's
 * working day — so a wrong time here pays the wrong amount silently rather than failing.
 */
describe('SlotEditor', () => {
  it('defaults a new slot to the location hours and the next free number', async () => {
    slotsQuery.data = [{ locationId: 'l1', slotNumber: 1, startsAt: '08:00', endsAt: '14:00' }];
    render(<SlotEditor location={LOCATION as never} />);
    // Slot 1 is taken, so the form offers 2 — not 1, which would silently overwrite it.
    expect(screen.getByLabelText(t.setup.slotNumber)).toHaveValue(2);
    expect(screen.getByLabelText(t.setup.opensAt)).toHaveValue('08:00');
    expect(screen.getByLabelText(t.setup.closesAt)).toHaveValue('20:00');
  });

  it('saves a slot for the location it belongs to', async () => {
    render(<SlotEditor location={LOCATION as never} />);
    await userEvent.clear(screen.getByLabelText(t.setup.opensAt));
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '14:00');
    await userEvent.click(screen.getByRole('button', { name: t.setup.saveSlot }));

    expect(setSlot.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'l1', slotNumber: 1, startsAt: '14:00' }),
    );
  });

  it('advances the slot number after saving, so entering a run of slots is uninterrupted', async () => {
    render(<SlotEditor location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.saveSlot }));
    expect(screen.getByLabelText(t.setup.slotNumber)).toHaveValue(2);
  });

  it('lists slots in number order regardless of what the API returned', () => {
    slotsQuery.data = [
      { locationId: 'l1', slotNumber: 2, startsAt: '14:00', endsAt: '20:00' },
      { locationId: 'l1', slotNumber: 1, startsAt: '08:00', endsAt: '14:00' },
    ];
    render(<SlotEditor location={LOCATION as never} />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items[0]).toContain(t.setup.slotN(1));
    expect(items[1]).toContain(t.setup.slotN(2));
  });

  it('deletes a slot by its number', async () => {
    slotsQuery.data = [{ locationId: 'l1', slotNumber: 3, startsAt: '08:00', endsAt: '14:00' }];
    render(<SlotEditor location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.deleteSlotN(3) }));
    expect(deleteSlot.mutateAsync).toHaveBeenCalledWith({ locationId: 'l1', slotNumber: 3 });
  });

  it('surfaces the API rejection when a window falls outside the location hours', async () => {
    // The API enforces this; the UI must not swallow the reason, because "why did nothing
    // happen" is unanswerable from a silent failure.
    setSlot.mutateAsync.mockRejectedValueOnce(
      new Error('slot window must fall inside the location working hours'),
    );
    render(<SlotEditor location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.saveSlot }));
    expect(
      await screen.findByText('slot window must fall inside the location working hours'),
    ).toBeInTheDocument();
  });

  it('refuses a malformed window rather than sending it', async () => {
    // A slot window decides how many hours an imported shift is worth, so a time the API would
    // reject is stopped here with the 24-hour format named.
    render(<SlotEditor location={LOCATION as never} />);
    const starts = screen.getByLabelText(t.setup.opensAt);
    await userEvent.clear(starts);
    await userEvent.type(starts, '2500');
    await userEvent.click(screen.getByRole('button', { name: t.setup.saveSlot }));

    expect(await screen.findByText(t.common.timeInvalid)).toBeInTheDocument();
    expect(setSlot.mutateAsync).not.toHaveBeenCalled();
  });

  it('says slots are unset rather than showing an empty list', () => {
    render(<SlotEditor location={LOCATION as never} />);
    expect(screen.getByText(t.setup.noSlots)).toBeInTheDocument();
  });

  it('explains what slots do for payroll', () => {
    // The hint is the only place the consequence is stated; four bare time fields would not
    // tell an admin that these decide what an imported shift is worth.
    render(<SlotEditor location={LOCATION as never} />);
    expect(screen.getByText(t.setup.slotsHint)).toBeInTheDocument();
  });
});

/**
 * Inline row editing for locations and levels.
 *
 * Both had create-only UIs: a wrong location time or day rate could not be corrected without a
 * hand-written API call, which is exactly why the deployed locations still carry placeholder
 * hours. Wrapped in a <table> because these components render <tr>, and React warns (and jsdom
 * reparents) if a row is mounted outside one.
 */
function inTable(node: React.ReactNode) {
  return render(<table><tbody>{node}</tbody></table>);
}

describe('LocationRow', () => {
  it('saves edited hours for that location', async () => {
    inTable(<LocationRow location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.common.edit }));
    const opens = screen.getByLabelText(t.setup.opensAtFor('Перша'));
    await userEvent.clear(opens);
    await userEvent.type(opens, '07:30');
    await userEvent.click(screen.getByRole('button', { name: t.common.save }));

    expect(updateLocation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1', opensAt: '07:30', closesAt: '20:00' }),
    );
  });

  it('restores the stored values on cancel', async () => {
    // Leaving edited text on screen after cancelling reads as if it had been saved.
    inTable(<LocationRow location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.common.edit }));
    const name = screen.getByLabelText(t.setup.locationNameFor('Перша'));
    await userEvent.clear(name);
    await userEvent.type(name, 'Змінено');
    await userEvent.click(screen.getByRole('button', { name: t.common.cancel }));

    expect(screen.getByText('Перша')).toBeInTheDocument();
    expect(screen.queryByText('Змінено')).not.toBeInTheDocument();
    expect(updateLocation.mutateAsync).not.toHaveBeenCalled();
  });

  it('explains why a location with payroll history cannot be deleted', async () => {
    // The FK is deliberate: revenue and shifts are payroll history. The API's 409 message names
    // the actual options, which a generic failure would not.
    deleteLocation.mutateAsync.mockRejectedValueOnce(
      new Error('location still has revenue, shifts or shift slots and cannot be deleted'),
    );
    inTable(<LocationRow location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.deleteLocationFor('Перша') }));
    expect(
      await screen.findByText('location still has revenue, shifts or shift slots and cannot be deleted'),
    ).toBeInTheDocument();
  });

  it('expands slot configuration under the location it belongs to', async () => {
    inTable(<LocationRow location={LOCATION as never} />);
    expect(screen.queryByText(t.setup.slotsHint)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.setup.slots }));
    expect(screen.getByText(t.setup.slotsHint)).toBeInTheDocument();
  });

  it('refuses to save an impossible time instead of sending it to the API', async () => {
    // The hours are typed now, not picked, so this is reachable. The row says it in Ukrainian
    // rather than letting the API answer with an English 400 — and these hours are a payroll
    // input, since a day rate prorates against the location's working day.
    inTable(<LocationRow location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.common.edit }));
    const opens = screen.getByLabelText(t.setup.opensAtFor('Перша'));
    await userEvent.clear(opens);
    await userEvent.type(opens, '2500');
    await userEvent.click(screen.getByRole('button', { name: t.common.save }));

    expect(await screen.findByText(t.common.timeInvalid)).toBeInTheDocument();
    expect(updateLocation.mutateAsync).not.toHaveBeenCalled();
  });

  it('accepts a bare hour, completing it on the way out of the field', async () => {
    // `7` is how someone says "seven o'clock"; the field completes it rather than refusing it.
    inTable(<LocationRow location={LOCATION as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.common.edit }));
    const opens = screen.getByLabelText(t.setup.opensAtFor('Перша'));
    await userEvent.clear(opens);
    await userEvent.type(opens, '7');
    await userEvent.click(screen.getByRole('button', { name: t.common.save }));

    expect(updateLocation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1', opensAt: '07:00' }),
    );
  });
});

/**
 * The add forms are collapsed behind a button.
 *
 * Setup is read far more often than written — locations and levels are configured once — so two
 * permanently-open add Cards led the screen with empty inputs for work nobody was doing, and spent
 * two amber submit buttons where the design system allows about one primary action per view. The
 * behaviours pinned here are the ones a disclosure gets wrong: reopening with stale values, a
 * failed add that closes as if it saved, and focus dropping to <body> when the trigger vanishes.
 */
describe('collapsed add forms', () => {
  /**
   * The submit button inside the open form.
   *
   * The trigger and the submit deliberately carry the SAME word ("Додати локацію") — it names one
   * action, and renaming one of them would make the disclosure look like a different operation
   * from the add it performs. So they are told apart by `type`, which `getByRole` cannot filter on.
   */
  function submitButton(name: string) {
    const found = screen
      .getAllByRole('button', { name })
      .find((b) => (b as HTMLButtonElement).type === 'submit');
    if (!found) throw new Error(`no submit button named ${name}`);
    return found;
  }

  it('shows only the trigger until an admin asks for the locations form', async () => {
    render(<LocationsPanel />);
    expect(screen.queryByLabelText(t.setup.locationName)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    expect(screen.getByLabelText(t.setup.locationName)).toBeInTheDocument();
  });

  it('shows only the trigger until an admin asks for the levels form', async () => {
    render(<LevelsPanel />);
    expect(screen.queryByLabelText(t.setup.levelName)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: t.setup.addLevel }));
    expect(screen.getByLabelText(t.setup.levelName)).toBeInTheDocument();
  });

  it('focuses the first field on open, so the keyboard path continues where it left off', async () => {
    render(<LocationsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    expect(screen.getByLabelText(t.setup.locationName)).toHaveFocus();
  });

  it('adds the location and collapses back to the trigger', async () => {
    render(<LocationsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    await userEvent.type(screen.getByLabelText(t.setup.locationName), 'Друга');
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '08:00');
    await userEvent.type(screen.getByLabelText(t.setup.closesAt), '20:00');
    await userEvent.click(submitButton(t.setup.addLocation));

    expect(addLocation.mutateAsync).toHaveBeenCalledWith({
      name: 'Друга',
      opensAt: '08:00',
      closesAt: '20:00',
    });
    // The refetched table showing the new row is the confirmation; the form's job is done.
    expect(screen.queryByLabelText(t.setup.locationName)).not.toBeInTheDocument();
  });

  it('cancel collapses the form, clears the fields and returns focus to the trigger', async () => {
    render(<LocationsPanel />);
    const trigger = screen.getByRole('button', { name: t.setup.addLocation });
    await userEvent.click(trigger);
    await userEvent.type(screen.getByLabelText(t.setup.locationName), 'Покинута');
    await userEvent.click(screen.getByRole('button', { name: t.common.cancel }));

    expect(screen.queryByLabelText(t.setup.locationName)).not.toBeInTheDocument();
    expect(addLocation.mutateAsync).not.toHaveBeenCalled();
    // Focus back on the trigger: the button the user clicked has just been removed from the DOM,
    // and without this focus falls to <body> and a keyboard user restarts from the page top.
    expect(screen.getByRole('button', { name: t.setup.addLocation })).toHaveFocus();

    // Reopening must not re-present an abandoned entry as if it were pending.
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    expect(screen.getByLabelText(t.setup.locationName)).toHaveValue('');
  });

  it('keeps a rejected add open with the reason, then clears it on cancel', async () => {
    addLocation.mutateAsync.mockRejectedValueOnce(new Error('location name already exists'));
    render(<LocationsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    await userEvent.type(screen.getByLabelText(t.setup.locationName), 'Перша');
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '08:00');
    await userEvent.type(screen.getByLabelText(t.setup.closesAt), '20:00');
    await userEvent.click(submitButton(t.setup.addLocation));

    // Closing on a failure would read as a successful save.
    expect(await screen.findByText('location name already exists')).toBeInTheDocument();
    expect(screen.getByLabelText(t.setup.locationName)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: t.common.cancel }));
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    // A stale failure above a blank form describes nothing on screen.
    expect(screen.queryByText('location name already exists')).not.toBeInTheDocument();
  });

  it('refuses an out-of-range time and keeps the form open with the reason', async () => {
    render(<LocationsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    await userEvent.type(screen.getByLabelText(t.setup.locationName), 'Третя');
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '2500');
    await userEvent.type(screen.getByLabelText(t.setup.closesAt), '2000');
    await userEvent.click(submitButton(t.setup.addLocation));

    expect(await screen.findByText(t.common.timeInvalid)).toBeInTheDocument();
    expect(addLocation.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByLabelText(t.setup.locationName)).toBeInTheDocument();
  });

  it('sends the completed 24-hour times, not what was literally typed', async () => {
    render(<LocationsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    await userEvent.type(screen.getByLabelText(t.setup.locationName), 'Третя');
    // Typed the fast way: no colon, and a bare hour for the closing time.
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '830');
    await userEvent.type(screen.getByLabelText(t.setup.closesAt), '21');
    await userEvent.click(submitButton(t.setup.addLocation));

    expect(addLocation.mutateAsync).toHaveBeenCalledWith({
      name: 'Третя',
      opensAt: '08:30',
      closesAt: '21:00',
    });
  });

  it('closes the form on Escape, as the pay matrix and schedule popover do', async () => {
    render(<LevelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLevel }));
    await userEvent.type(screen.getByLabelText(t.setup.levelName), 'Бариста');
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByLabelText(t.setup.levelName)).not.toBeInTheDocument();
    expect(addLevel.mutateAsync).not.toHaveBeenCalled();
  });

  it('adds the level and collapses', async () => {
    render(<LevelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.addLevel }));
    await userEvent.type(screen.getByLabelText(t.setup.levelName), 'Старший бариста');
    await userEvent.click(submitButton(t.setup.addLevel));

    expect(addLevel.mutateAsync).toHaveBeenCalledWith({ name: 'Старший бариста' });
    expect(screen.queryByLabelText(t.setup.levelName)).not.toBeInTheDocument();
  });

  it('keeps the trigger secondary, so the amber stays on the write inside the form', async () => {
    // docs/design/system.md § Color: amber is the primary action in a view, and revealing a form
    // is not the write. Two amber "Додати" triggers under two tables would spend the screen's
    // loudest signal on disclosure.
    render(<LocationsPanel />);
    expect(screen.getByRole('button', { name: t.setup.addLocation })).not.toHaveClass('btn--primary');

    await userEvent.click(screen.getByRole('button', { name: t.setup.addLocation }));
    expect(submitButton(t.setup.addLocation)).toHaveClass('btn--primary');
  });
});

describe('LevelRow', () => {
  const LEVEL = { id: 'lv1', name: 'Бариста' };

  it('saves an edited name', async () => {
    inTable(<LevelRow level={LEVEL as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.common.edit }));
    const name = screen.getByLabelText(t.setup.levelNameFor('Бариста'));
    await userEvent.clear(name);
    await userEvent.type(name, 'Бариста-2');
    await userEvent.click(screen.getByRole('button', { name: t.common.save }));

    expect(updateLevel.mutateAsync).toHaveBeenCalledWith({
      id: 'lv1',
      name: 'Бариста-2',
    });
  });

  it('surfaces the API 409 when an employee still uses the level', async () => {
    deleteLevel.mutateAsync.mockRejectedValueOnce(new Error('level is still used by an employee'));
    inTable(<LevelRow level={LEVEL as never} />);
    await userEvent.click(screen.getByRole('button', { name: t.setup.deleteLevelFor('Бариста') }));
    expect(await screen.findByText('level is still used by an employee')).toBeInTheDocument();
  });
});
