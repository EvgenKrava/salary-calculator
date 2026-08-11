import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { Toolbar } from '../ui/Toolbar';
import { Figure } from '../ui/Figure';
import { useMyShifts } from '../lib/queries';
import { shiftHours } from '../lib/hours';
import { t, formatDate } from '../lib/i18n';

/** An employee's own shifts — date, window, hours, status. Read-only: approving is a
 * manager action, done on the Shifts screen. */
export function MyShiftsRoute() {
  const shifts = useMyShifts();

  if (shifts.isLoading) return <Loading what={t.myShifts.title.toLowerCase()} />;
  if (shifts.error) {
    return <LoadFailure what={t.myShifts.title.toLowerCase()} error={shifts.error as Error} />;
  }

  const rows = shifts.data ?? [];
  /*
   * Total hours across the shifts shown.
   *
   * A Ledger leads with the period total and this one summed nothing — an employee checking their
   * shifts is checking how many hours they are owed for, and they had to add a column of decimals
   * by hand. `tone="plain"` keeps amber tied to money: these are hours, not a payable figure, and
   * the pay for them is the display figure on the My-pay screen.
   *
   * Summed from the same formatted strings the rows print, so the total cannot disagree with the
   * column above it by a rounding cent.
   */
  const totalHours = rows.reduce((sum, s) => sum + Number(shiftHours(s.startsAt, s.endsAt)), 0);

  return (
    <>
      <Toolbar title={t.myShifts.title} />
      {rows.length === 0 ? (
        <EmptyState title={t.myShifts.empty} action={t.myShifts.emptyAction} />
      ) : (
        <>
          <div className="ledger__head">
            <Figure
              value={totalHours.toFixed(2)}
              unit={t.myShifts.hoursUnit}
              label={t.myShifts.totalHours}
              tone="plain"
            />
            <p className="muted">{t.myShifts.shiftCount(rows.length)}</p>
          </div>
          <Table caption={t.myShifts.title}>
            <thead>
              <tr>
                <Th>{t.common.date}</Th>
                <Th>{t.shifts.window}</Th>
                <Th numeric>{t.common.hours}</Th>
                <Th>{t.common.status}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  {/* data-labels so the 640px stacked layout keeps each figure with its column
                      name — this is the screen most likely to be read on a phone. */}
                  <Td label={t.common.date}><span className="mono">{formatDate(s.workDate)}</span></Td>
                  <Td label={t.shifts.window}><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                  <NumCell label={t.common.hours}>{shiftHours(s.startsAt, s.endsAt)}</NumCell>
                  <Td label={t.common.status}><StatusPill status={s.status} /></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td label={t.common.total}>{t.common.total}</Td>
                <Td> </Td>
                <NumCell label={t.common.hours}>{totalHours.toFixed(2)}</NumCell>
                <Td> </Td>
              </tr>
            </tfoot>
          </Table>
        </>
      )}
    </>
  );
}
