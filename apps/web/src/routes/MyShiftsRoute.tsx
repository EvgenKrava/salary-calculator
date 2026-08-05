import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { EmptyState } from '../ui/EmptyState';
import { useMyShifts } from '../lib/queries';

function hours(startsAt: string, endsAt: string): string {
  const [sh, sm] = startsAt.split(':').map(Number);
  const [eh, em] = endsAt.split(':').map(Number);
  return (((eh * 60 + em) - (sh * 60 + sm)) / 60).toFixed(2);
}

/** An employee's own shifts — date, window, hours, status. Read-only: approving is a
 * manager action, done on the Shifts screen. */
export function MyShiftsRoute() {
  const shifts = useMyShifts();

  if (shifts.isLoading) return <p className="mono">loading…</p>;
  if (shifts.error) return <p style={{ color: 'var(--stop)' }}>{(shifts.error as Error).message}</p>;

  const rows = shifts.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>My shifts</h1>
      {rows.length === 0 ? (
        <EmptyState title="No shifts yet." action="Shifts appear here once a manager assigns or approves them." />
      ) : (
        <Table caption="My shifts">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Window</Th>
              <Th numeric>Hours</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td><span className="mono">{s.workDate}</span></Td>
                <Td><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                <NumCell>{hours(s.startsAt, s.endsAt)}</NumCell>
                <Td><StatusPill status={s.status} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
