import { useEffect, useMemo, useRef, useState } from 'react';
import { Toolbar } from '../ui/Toolbar';
import { MonthSelect } from '../ui/Select';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { anyLoading, firstError, Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { buildMonthGrid } from './ScheduleRoute';
import { PublishPanel } from './PublishPanel';
import {
  useAssignShift,
  useDayOffRequests,
  useDeleteShift,
  useEmployees,
  useLocations,
  usePublicationState,
  useShiftSlotsByLocation,
  useShifts,
  type DayOffRequest,
  type Location,
  type Shift,
} from '../lib/queries';
import { t } from '../lib/i18n';
import './scheduleGrid.css';

/**
 * Build a month by hand: rows are people, columns are days, a cell holds a location number.
 *
 * This is the same shape as the client's own workbook block, so the mental model transfers
 * directly — and it is the structure the xlsx import will pre-fill in Stage 2 rather than writing
 * shifts straight to the database.
 *
 * One grid per shift slot, switched by tabs, because the workbook stacks a block per slot and one
 * person may legitimately work morning at one café and evening at another. A cell therefore holds
 * exactly one location, which keeps entry to a single click.
 */
export function ScheduleGrid() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [slot, setSlot] = useState(1);
  const [openCell, setOpenCell] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cells = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const monthDays = useMemo(() => cells.filter((c) => c.inMonth), [cells]);
  const from = monthDays[0]?.iso ?? '';
  const to = monthDays[monthDays.length - 1]?.iso ?? '';

  const shifts = useShifts({ from, to });
  const employees = useEmployees();
  const locations = useLocations();
  const dayOff = useDayOffRequests({ year, month });
  const assign = useAssignShift();
  const remove = useDeleteShift();

  /*
   * Slot windows for EVERY location, not just the first.
   *
   * Each café has its own opening hours, so slot 1 is 08:00–14:00 at one and 09:00–15:00 at
   * another. Writing the first location's window for every cell records the wrong hours — and
   * hours are pay, because a day rate prorates against the location's working day.
   */
  const locationIds = useMemo(
    () => (locations.data ?? []).map((l) => l.id),
    [locations.data],
  );
  const slots = useShiftSlotsByLocation(locationIds);

  /*
   * Whether the displayed month is already published — the same query `PublishPanel` reads
   * further down this tree. A cell write needs this to know whether to write `approved` or
   * `draft`: writing into a published month as `draft` recreates the payroll-invisible state
   * this whole feature exists to close, whether the cell was previously empty or is being
   * corrected after a refused re-insert.
   */
  const publication = usePublicationState({ year, month });

  // Escape closes the location popover — a click-anywhere-else dismissal alone leaves a keyboard
  // user with no way out.
  useEffect(() => {
    if (openCell === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenCell(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCell]);

  /*
   * The slot windows gate the whole screen, not just the tabs.
   *
   * A cell written while the windows are unknown POSTs no startsAt/endsAt, and the API falls back
   * to the location's full opening hours — a 6-hour shift recorded as a 12-hour day, which is a pay
   * figure. Showing a banner above a still-clickable table left that write reachable, and so did
   * rendering the table during the ordinary gap before these queries resolve: they cannot start
   * until `locations` has told them which locations to ask about. So the grid does not exist until
   * the hours are known.
   *
   * `publication` gates the same way, for the same reason: `setCell` below decides `approved` vs
   * `draft` from whether the month is published, and while that query is pending the answer is
   * unknown — a write in that window would default to the wrong status exactly like an unknown
   * slot window defaults to the wrong hours.
   */
  if (anyLoading(shifts, employees, locations, slots, publication)) {
    return <Loading what={t.scheduleGrid.title.toLowerCase()} />;
  }
  const loadError = firstError(shifts, employees, locations, publication);
  if (loadError) return <LoadFailure what={t.scheduleGrid.title.toLowerCase()} error={loadError} />;
  // Its own message rather than the generic one: a failed read means the hours are UNKNOWN, which
  // is a different fix from "an admin has not configured any slots yet".
  if (slots.error) {
    return <LoadFailure title={t.scheduleGrid.slotsFailed} hint={t.scheduleGrid.slotsFailedHint} />;
  }

  const people = (employees.data ?? []).filter((e) => e.active);
  const locs = locations.data ?? [];
  const slotNumbers = slots.slotNumbers;

  /** The window for a location's active slot, or undefined when that location has no such slot. */
  const windowFor = (locationId: string) =>
    slots.byLocation.get(locationId)?.find((s) => s.slotNumber === slot);

  /**
   * Shift for (person, day, active slot).
   *
   * Matched on the shift's own start time against the window of the shift's OWN location, so a
   * morning at café 1 and an evening at café 2 stay in their separate slot grids even though their
   * windows differ.
   */
  const shiftAt = (employeeId: string, iso: string): Shift | undefined =>
    (shifts.data ?? []).find((s) => {
      if (s.employeeId !== employeeId || s.workDate !== iso) return false;
      const window = windowFor(s.locationId);
      // No configured window for that location's slot: fall back to showing it in every slot
      // rather than hiding a real shift.
      return window ? s.startsAt === window.startsAt : true;
    });

  const dayOffAt = (employeeId: string, iso: string) =>
    (dayOff.data ?? []).find((r) => r.employeeId === employeeId && r.requestDate === iso);

  const kindWord = (request: DayOffRequest) =>
    request.kind === 'required' ? t.scheduleGrid.conflictRequired : t.scheduleGrid.conflictPreferred;

  /**
   * Accessible name carrying what colour alone would otherwise encode.
   *
   * The design system forbids meaning in colour only — managers print these, and a screen-reader
   * user got no signal at all from a background tint.
   */
  function cellLabel(name: string, day: number, locName: string, request?: DayOffRequest): string {
    if (locName && request) return t.scheduleGrid.cellLabelFilledDayOff(name, day, locName, kindWord(request));
    if (locName) return t.scheduleGrid.cellLabelFilled(name, day, locName);
    if (request) return t.scheduleGrid.cellLabelDayOff(name, day, kindWord(request));
    return t.scheduleGrid.cellLabel(name, day);
  }

  /**
   * Point a cell at a location, replacing whatever was there.
   *
   * Delete-then-insert, because a cell holds exactly ONE location and the uniqueness constraint is
   * (employee, date, location, start): a plain insert on a changed cell appends a second row
   * instead of moving the first. Publishing then flipped both, leaving one person two approved
   * shifts in the same window — on a 600.00/day level that priced 300.00 as 600.00, the same hours
   * paid twice, with the grid showing only one of them.
   *
   * Not atomic, and deliberately not pretended to be: if the insert fails after the delete, the
   * error is shown and the month refetched, so the manager sees the cell is now empty rather than
   * a stale value that is no longer in the database.
   *
   * The write's status is driven by whether the DISPLAYED MONTH is published, not just by
   * `existing?.status`. Carrying only the existing shift's status forward left two reachable
   * paths writing an invisible draft into an already-live month:
   *
   *   1. An approved re-insert that 409s on overlap leaves the delete committed and the insert
   *      refused — the cell is now empty. The manager's natural recovery is to click it and
   *      re-pick a location, which reads `existing` as undefined and fell through to `draft`.
   *   2. Any empty cell in a published month falls through to `draft` on the very first write,
   *      with nothing on screen distinguishing it from the live shifts around it.
   *
   * Both reproduce exactly the payroll-invisible state this feature exists to close. So the
   * publication flag comes first: published → `approved` for any write, new or edited. The
   * `existing?.status === 'approved'` fallback stays as a second line — it should be
   * unreachable before publish, since nothing else in the app creates an approved draft-month
   * shift — but a write must never regress an already-approved cell to draft even if that
   * invariant is ever violated elsewhere.
   */
  async function setCell(employeeId: string, iso: string, locationId: string, existing?: Shift) {
    setError(null);
    setOpenCell(null);
    const window = windowFor(locationId);
    try {
      if (existing) {
        if (existing.locationId === locationId && existing.startsAt === window?.startsAt) return;
        await remove.mutateAsync(existing.id);
      }
      await assign.mutateAsync({
        employeeId,
        locationId,
        workDate: iso,
        startsAt: window?.startsAt,
        endsAt: window?.endsAt,
        // A draft is invisible to staff and uncounted by payroll until the month is published.
        // A write into an already-published month is a real, live change — the spec's own
        // words are "a mid-month change is real, not a draft" — so it goes straight to
        // `approved`, which also means the API's overlap check runs against it.
        status: publication.data?.published || existing?.status === 'approved' ? 'approved' : 'draft',
      });
    } catch (err) {
      setError((err as Error).message);
      void shifts.refetch();
    }
  }

  async function clearCell(shiftId: string) {
    setError(null);
    setOpenCell(null);
    try {
      await remove.mutateAsync(shiftId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <Toolbar title={t.scheduleGrid.title} description={t.scheduleGrid.hint}>
        <MonthSelect label={t.schedule.month} value={String(month)} onChange={(v) => setMonth(Number(v))} />
        <input
          className="field__input field__input--year mono"
          type="number"
          aria-label={t.schedule.year}
          value={year}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n)) setYear(n);
          }}
        />
      </Toolbar>

      {slotNumbers.length === 0 ? (
        <p className="muted">{t.scheduleGrid.noSlots}</p>
      ) : (
        <div className="grid__tabs" role="tablist">
          {slotNumbers.map((n) => {
            // Label from the first location that defines this slot; per-location windows still
            // drive what gets written.
            const sample = [...slots.byLocation.values()].flat().find((s) => s.slotNumber === n);
            return (
              <button
                key={n}
                type="button"
                role="tab"
                aria-selected={n === slot}
                className={`grid__tab${n === slot ? ' grid__tab--active' : ''}`}
                onClick={() => setSlot(n)}
              >
                {sample ? t.scheduleGrid.slotTab(n, sample.startsAt, sample.endsAt) : t.setup.slotN(n)}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid__wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="grid__corner">{t.common.employee}</th>
              {monthDays.map((c) => (
                <th key={c.iso} className="grid__dayhead" scope="col">{c.day}</th>
              ))}
              <th className="grid__total" scope="col">{t.scheduleGrid.shiftsPerPerson}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const count = monthDays.filter((c) => shiftAt(person.id, c.iso)).length;
              return (
                <tr key={person.id}>
                  <th scope="row" className="grid__name">{person.name}</th>
                  {monthDays.map((c) => {
                    const shift = shiftAt(person.id, c.iso);
                    const request = dayOffAt(person.id, c.iso);
                    const cellKey = `${person.id}:${c.iso}`;
                    const locName = shift ? locs.find((l) => l.id === shift.locationId)?.name ?? '?' : '';
                    const open = openCell === cellKey;
                    return (
                      <GridCell
                        key={c.iso}
                        day={c.day}
                        label={cellLabel(person.name, c.day, locName, request)}
                        locName={locName}
                        shift={shift}
                        request={request}
                        open={open}
                        onToggle={() => setOpenCell(open ? null : cellKey)}
                        locations={locs}
                        onPick={(locationId) => void setCell(person.id, c.iso, locationId, shift)}
                        onClear={() => shift && void clearCell(shift.id)}
                      />
                    );
                  })}
                  {/* data-label carries the column heading into the ≤720px layout, where thead is
                      hidden and the figure would otherwise read as a bare number. */}
                  <td className="grid__total mono" data-label={t.scheduleGrid.shiftsPerPerson}>{count}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="grid__name">{t.scheduleGrid.peoplePerDay}</th>
              {monthDays.map((c) => (
                <td key={c.iso} className="grid__total mono" data-day={c.day}>
                  {people.filter((p) => shiftAt(p.id, c.iso)).length}
                </td>
              ))}
              <td className="grid__total" />
            </tr>
          </tfoot>
        </table>
      </div>

      {error ? <p className="grid__error">{error}</p> : null}

      <PublishPanel year={year} month={month} />
    </>
  );
}

/**
 * One day for one person: the button, and the location menu it opens.
 *
 * Its own component so each cell can hold a ref to its own trigger, which is what
 * `AnchoredPopover` positions against. The menu is portalled to `<body>` rather than absolutely
 * positioned in this `<td>`: `.grid__wrap` needs `overflow-x: auto` for 31 columns, and an overflow
 * container clips absolutely-positioned descendants — so the list was cut off on the last row and
 * the last day column, which are ordinary cells to fill.
 */
function GridCell({
  day,
  label,
  locName,
  shift,
  request,
  open,
  onToggle,
  locations,
  onPick,
  onClear,
}: {
  day: number;
  label: string;
  locName: string;
  shift?: Shift;
  request?: DayOffRequest;
  open: boolean;
  onToggle: () => void;
  locations: Location[];
  onPick: (locationId: string) => void;
  onClear: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <td className="grid__cellwrap" data-day={day}>
      <button
        ref={trigger}
        type="button"
        className={[
          'grid__cell',
          locName ? 'grid__cell--filled' : '',
          shift?.status === 'approved' ? 'grid__cell--published' : '',
          request?.kind === 'required' ? 'grid__cell--required' : '',
          request?.kind === 'preferred' ? 'grid__cell--preferred' : '',
        ].filter(Boolean).join(' ')}
        aria-label={label}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="grid__cellValue">{locName || t.scheduleGrid.emptyCell}</span>
        {/* A glyph beside the tint: colour is never the only carrier, and these screens get
            printed. */}
        {request ? (
          <span className="grid__cellMark" aria-hidden="true">
            {request.kind === 'required' ? t.scheduleGrid.markRequired : t.scheduleGrid.markPreferred}
          </span>
        ) : null}
      </button>
      {open ? (
        <AnchoredPopover anchor={trigger} onDismiss={onToggle} label={t.scheduleGrid.chooseLocation}>
          {locations.map((l) => (
            <button key={l.id} type="button" className="popover__option" onClick={() => onPick(l.id)}>
              {l.name}
            </button>
          ))}
          {shift ? (
            <button type="button" className="popover__option popover__option--clear" onClick={onClear}>
              {t.scheduleGrid.clearCell}
            </button>
          ) : null}
        </AnchoredPopover>
      ) : null}
    </td>
  );
}
