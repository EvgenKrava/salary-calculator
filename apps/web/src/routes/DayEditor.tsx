import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { StatusPill } from '../ui/StatusPill';
import {
  useAssignShift,
  useDeleteShift,
  useShiftSlots,
  type Employee,
  type Location,
  type Shift,
} from '../lib/queries';
import { t, formatDate } from '../lib/i18n';
import './dayEditor.css';

/**
 * Add and remove shifts for one calendar day.
 *
 * The schedule was read-only: the only way a shift reached the app was a workbook import, and
 * the importer deliberately refuses to guess. On the real client file that leaves 148
 * **substitutions** — a covering person's name written where a location number belongs — parsed,
 * reported, and never imported. Those people worked and would not be paid. This is the screen
 * that closes that gap, and the one a manager needs when a shift changes after the workbook was
 * filled in.
 *
 * Deliberately scoped to ONE day. A month-wide bulk editor is a different, riskier tool; the
 * actual need is "Оксана covered Друга on the 14th", which is a single-day edit.
 */
export function DayEditor({
  date,
  shifts,
  employees,
  locations,
  onClose,
}: {
  date: string;
  shifts: Shift[];
  employees: Employee[];
  locations: Location[];
  onClose: () => void;
}) {
  const assign = useAssignShift();
  const remove = useDeleteShift();
  const [employeeId, setEmployeeId] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  /**
   * Slot choice, or `custom` for a hand-typed window.
   *
   * Slots are offered first because they are what the rest of the system is built around — the
   * importer maps onto them and revenue share prorates against them. A free-text window is the
   * escape hatch for a genuinely irregular shift, not the default.
   */
  const [slot, setSlot] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const slots = useShiftSlots(locationId || undefined);
  const active = employees.filter((e) => e.active);
  const location = locations.find((l) => l.id === locationId);

  const CUSTOM = '__custom__';
  const chosenSlot = slots.data?.find((s) => String(s.slotNumber) === slot);
  const isCustom = slot === CUSTOM;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!employeeId) {
      setError(t.dayEditor.chooseEmployee);
      return;
    }
    try {
      await assign.mutateAsync({
        employeeId,
        locationId,
        workDate: date,
        /*
         * Three cases, in order of preference:
         *  - a slot was chosen → its window;
         *  - `custom` → the typed window;
         *  - neither (the location has no slots configured) → omit, and let the API fall back to
         *    the location's opening hours.
         * Sending `undefined` rather than '' matters: the API's schema rejects an empty string.
         */
        startsAt: isCustom ? startsAt || undefined : chosenSlot?.startsAt,
        endsAt: isCustom ? endsAt || undefined : chosenSlot?.endsAt,
      });
      // Keep the form open with the location and slot intact — filling a day usually means
      // entering several people into the same slot, and re-choosing every time is friction.
      setEmployeeId('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteShift(id: string) {
    setError(null);
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="day-editor">
      {shifts.length === 0 ? (
        <p className="muted">{t.dayEditor.noShifts}</p>
      ) : (
        <ul className="day-editor__list">
          {shifts.map((s) => (
            <li key={s.id} className="day-editor__row">
              <span className="day-editor__who">
                {employees.find((e) => e.id === s.employeeId)?.name ?? '—'}
              </span>
              <span className="day-editor__meta mono">
                {s.startsAt}–{s.endsAt}
              </span>
              <span className="day-editor__meta">
                {locations.find((l) => l.id === s.locationId)?.name ?? '—'}
              </span>
              <StatusPill status={s.status} />
              {/*
               * Delete, not "reject": a hand-entered shift that was a mistake should leave no
               * trace, whereas rejecting is a decision about a real request. The API's DELETE
               * removes the row outright.
               */}
              <Button
                size="sm"
                variant="danger"
                onClick={() => void deleteShift(s.id)}
                disabled={remove.isPending}
                aria-label={t.dayEditor.removeShiftFor(
                  employees.find((e) => e.id === s.employeeId)?.name ?? '',
                )}
              >
                {t.dayEditor.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="day-editor__form">
        <h3>{t.dayEditor.addTitle}</h3>
        <div className="field-row">
          <Select
            label={t.common.employee}
            name="employeeId"
            size="wide"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">{t.dayEditor.chooseEmployeePlaceholder}</option>
            {active.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>

          <Select
            label={t.common.location}
            name="locationId"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              // Slot numbers are per-location, so a slot chosen for the previous location is
              // meaningless here — clearing avoids silently applying the wrong window.
              setSlot('');
            }}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>

          <Select
            label={t.dayEditor.window}
            name="slot"
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
          >
            {/* Default: the location's own opening hours, which is right for a single-slot day. */}
            <option value="">
              {location ? `${location.opensAt}–${location.closesAt}` : t.dayEditor.wholeDay}
            </option>
            {(slots.data ?? []).map((s) => (
              <option key={s.slotNumber} value={String(s.slotNumber)}>
                {t.dayEditor.slotLabel(s.slotNumber)} · {s.startsAt}–{s.endsAt}
              </option>
            ))}
            <option value={CUSTOM}>{t.dayEditor.customWindow}</option>
          </Select>
        </div>

        {isCustom ? (
          <div className="field-row">
            <Field
              label={t.dayEditor.startsAt}
              name="startsAt"
              type="time"
              numeric
              required
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
            <Field
              label={t.dayEditor.endsAt}
              name="endsAt"
              type="time"
              numeric
              required
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
        ) : null}

        {error ? <p className="day-editor__error">{error}</p> : null}

        <div className="day-editor__actions">
          <Button type="submit" variant="primary" disabled={assign.isPending || active.length === 0}>
            {assign.isPending ? t.common.saving : t.dayEditor.add}
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>

        {active.length === 0 ? <p className="muted">{t.dayEditor.noEmployees}</p> : null}
        <p className="muted">{t.dayEditor.hint(formatDate(date))}</p>
      </form>
    </div>
  );
}
