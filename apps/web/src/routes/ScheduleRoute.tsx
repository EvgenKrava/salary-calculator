import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Toolbar } from '../ui/Toolbar';
import { ImportPanel } from './ImportRoute';
import { MonthSelect } from '../ui/Select';
import { StatusPill } from '../ui/StatusPill';
import { anyLoading, firstError } from '../ui/QueryGate';
import { useEmployees, useLocations, useShifts, type Shift } from '../lib/queries';
import { t } from '../lib/i18n';
import './schedule.css';

/**
 * A month calendar of who works where — the primary way a manager reads the schedule.
 *
 * `ShiftsRoute` (the flat table) still exists for approving/rejecting requests; this screen
 * answers a different question — "who is where, on which day" — which a table of 200+ rows
 * sorted by date cannot answer at a glance. Read-only by design: decisions happen on Shifts.
 */

interface Cell {
  /** UTC day-of-month timestamp, used only to derive the ISO key and label — never rendered
   * directly, since `formatDate` and the API both work off the `YYYY-MM-DD` string. */
  iso: string;
  day: number;
  inMonth: boolean;
}

/**
 * Build a Monday-first month grid as ISO date strings, padded to full weeks.
 *
 * Every date is constructed with `Date.UTC` and read back with `getUTC*` — the plan this task
 * came with is explicit that `new Date('2026-05-05')` parses as UTC midnight and can render as
 * the previous day in a negative-offset timezone. Working entirely in UTC here means no local
 * timezone ever enters the calculation, so the grid cannot drift from the API's own `work_date`
 * strings.
 */
export function buildMonthGrid(year: number, month1to12: number): Cell[] {
  const monthIndex0 = month1to12 - 1;
  const first = new Date(Date.UTC(year, monthIndex0, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();

  // JS getUTCDay() is Sunday=0..Saturday=6; Ukrainian weeks start Monday, so shift the index.
  const firstWeekday = first.getUTCDay();
  const leadingBlanks = (firstWeekday + 6) % 7;

  const cells: Cell[] = [];
  // Pad with the tail of the previous month so the first row still starts on Monday.
  for (let i = leadingBlanks; i > 0; i--) {
    const d = new Date(Date.UTC(year, monthIndex0, 1 - i));
    cells.push({ iso: isoOf(d), day: d.getUTCDate(), inMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, monthIndex0, day));
    cells.push({ iso: isoOf(d), day, inMonth: true });
  }
  // Pad with the start of the next month so the last row completes a full week.
  while (cells.length % 7 !== 0) {
    const d = new Date(Date.UTC(year, monthIndex0, daysInMonth + (cells.length - leadingBlanks - daysInMonth) + 1));
    cells.push({ iso: isoOf(d), day: d.getUTCDate(), inMonth: false });
  }
  return cells;
}

function isoOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** First and last ISO date of the visible grid — used to scope the shifts query to the month
 * actually on screen (plus the lead/trail days from adjacent months shown in the grid). */
function gridBounds(cells: Cell[]): { from: string; to: string } {
  return { from: cells[0].iso, to: cells[cells.length - 1].iso };
}

function todayIso(): string {
  return isoOf(new Date());
}

export function DayCell({
  cell,
  shifts,
  nameOf,
  locOf,
  isToday,
}: {
  cell: Cell;
  shifts: Shift[];
  nameOf: (id: string) => string;
  locOf: (id: string) => string;
  isToday: boolean;
}) {
  return (
    <div
      className={`schedule__cell${cell.inMonth ? '' : ' schedule__cell--outside'}${isToday ? ' schedule__cell--today' : ''}`}
      aria-label={isToday ? `${cell.day} (${t.schedule.today})` : String(cell.day)}
    >
      <span className="schedule__daynum">{cell.day}</span>
      {shifts.length === 0 ? (
        // An empty day is normal — no placeholder text, just quiet whitespace, so a manager
        // scanning the month is not stopped by every closed day.
        <span className="schedule__empty" aria-hidden="true" />
      ) : (
        <ul className="schedule__entries">
          {shifts.map((s) => (
            <li key={s.id} className="schedule__entry">
              <span className="schedule__entry-name">{nameOf(s.employeeId)}</span>
              <span className="schedule__entry-meta">
                <span className="mono">{s.startsAt}–{s.endsAt}</span>
                <span className="schedule__entry-loc">{locOf(s.locationId)}</span>
              </span>
              <StatusPill status={s.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScheduleRoute() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);

  const cells = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const { from, to } = useMemo(() => gridBounds(cells), [cells]);

  const shifts = useShifts({ from, to });
  const [importOpen, setImportOpen] = useState(false);
  const employees = useEmployees();
  const locations = useLocations();

  function goToPrevMonth() {
    if (month === 1) {
      setYear((y) => y - 1);
      setMonth(12);
    } else {
      setMonth((m) => m - 1);
    }
  }

  function goToNextMonth() {
    if (month === 12) {
      setYear((y) => y + 1);
      setMonth(1);
    } else {
      setMonth((m) => m + 1);
    }
  }

  if (anyLoading(shifts, employees, locations)) return <p className="mono">{t.common.loading}</p>;
  // A failed employees/locations query must not degrade into a grid full of blank names — the
  // same trap QueryGate exists to catch on ShiftsRoute.
  const loadError = firstError(shifts, employees, locations);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>
          {t.common.couldNotLoad(t.schedule.title.toLowerCase())}
        </h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
        <p style={{ marginBottom: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>{t.common.reload}</p>
      </div>
    );
  }

  const nameOf = (id: string) => employees.data?.find((e) => e.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? '—';
  const byDay = new Map<string, Shift[]>();
  for (const s of shifts.data ?? []) {
    const list = byDay.get(s.workDate) ?? [];
    list.push(s);
    byDay.set(s.workDate, list);
  }
  // Within a day, a stable order — earliest shift first — so the same person's row does not
  // jump around as approvals come in.
  for (const list of byDay.values()) list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const today = todayIso();
  const monthValue = String(month);

  return (
    <>
      {/* Import is an action on this page, not a separate destination: a manager importing a
          schedule is already looking at the month they want to fill, and navigating away lost
          that context. */}
      <Toolbar title={t.schedule.title}>
        <Button onClick={() => setImportOpen(true)}>{t.nav.import}</Button>
      </Toolbar>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t.importScreen.title}
        description={t.importScreen.hint}
      >
        <ImportPanel
          onCommitted={() => {
            // Refetch so the calendar behind the modal shows the shifts just imported, rather
            // than a month that predates the manager's own action.
            void shifts.refetch();
          }}
        />
      </Modal>

      <div className="schedule__nav">
        <Button aria-label={t.schedule.prevMonth} onClick={goToPrevMonth}>
          ‹
        </Button>
        <MonthSelect label={t.schedule.month} value={monthValue} onChange={(v) => setMonth(Number(v))} />
        <input
          className="field__input mono schedule__year"
          type="number"
          aria-label={t.schedule.year}
          value={year}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n)) setYear(n);
          }}
        />
        <Button aria-label={t.schedule.nextMonth} onClick={goToNextMonth}>
          ›
        </Button>
      </div>

      <div className="schedule__grid">
        {t.schedule.weekdays.map((wd) => (
          <div key={wd} className="schedule__weekday">{wd}</div>
        ))}
        {cells.map((cell) => (
          <DayCell
            key={cell.iso}
            cell={cell}
            shifts={byDay.get(cell.iso) ?? []}
            nameOf={nameOf}
            locOf={locOf}
            isToday={cell.iso === today}
          />
        ))}
      </div>
    </>
  );
}
