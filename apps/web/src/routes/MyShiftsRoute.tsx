import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { EmptyState } from '../ui/EmptyState';
import { useMyShifts } from '../lib/queries';
import { shiftHours } from '../lib/hours';
import { t, formatDate } from '../lib/i18n';

/** An employee's own shifts — date, window, hours, status. Read-only: approving is a
 * manager action, done on the Shifts screen. */
export function MyShiftsRoute() {
  const shifts = useMyShifts();

  if (shifts.isLoading) return <p className="mono">{t.common.loading}</p>;
  if (shifts.error) return <p style={{ color: 'var(--stop)' }}>{(shifts.error as Error).message}</p>;

  const rows = shifts.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.myShifts.title}</h1>
      {rows.length === 0 ? (
        <EmptyState title={t.myShifts.empty} action={t.myShifts.emptyAction} />
      ) : (
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
                <Td><span className="mono">{formatDate(s.workDate)}</span></Td>
                <Td><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                <NumCell>{shiftHours(s.startsAt, s.endsAt)}</NumCell>
                <Td><StatusPill status={s.status} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
