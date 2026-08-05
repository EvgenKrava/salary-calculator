import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { anyLoading, firstError } from '../ui/QueryGate';
import { useEmployees, useLocations, useShiftDecision, useShifts } from '../lib/queries';
import { shiftHours } from '../lib/hours';

export function ShiftsRoute() {
  const shifts = useShifts();
  const employees = useEmployees();
  const locations = useLocations();
  const decide = useShiftDecision();

  if (anyLoading(shifts, employees, locations)) return <p className="mono">loading…</p>;
  // Without this, a failed employees/locations query left every name and location reading '—'
  // in a table that otherwise looked fine.
  const loadError = firstError(shifts, employees, locations);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>Could not load shifts</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
      </div>
    );
  }

  const rows = shifts.data ?? [];
  const nameOf = (id: string) => employees.data?.find((e) => e.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? '—';

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>Shifts</h1>
      {rows.length === 0 ? (
        <EmptyState title="No shifts scheduled." action="Import a schedule or wait for requests." />
      ) : (
        <Table caption="Scheduled shifts">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Employee</Th>
              <Th>Location</Th>
              <Th>Window</Th>
              <Th numeric>Hours</Th>
              <Th>Status</Th>
              <Th>Source</Th>
              <Th>Decision</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td><span className="mono">{s.workDate}</span></Td>
                <Td>{nameOf(s.employeeId)}</Td>
                <Td>{locOf(s.locationId)}</Td>
                <Td><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                <NumCell>{shiftHours(s.startsAt, s.endsAt)}</NumCell>
                <Td><StatusPill status={s.status} /></Td>
                <Td>{s.source}</Td>
                <Td>
                  {s.status === 'requested' ? (
                    <span style={{ display: 'flex', gap: 'var(--s1)' }}>
                      <Button
                        variant="primary"
                        onClick={() => decide.mutate({ id: s.id, decision: 'approve' })}
                      >
                        Approve
                      </Button>
                      <Button variant="danger" onClick={() => decide.mutate({ id: s.id, decision: 'reject' })}>
                        Reject
                      </Button>
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {decide.error ? (
        // e.g. "overlaps an existing approved shift" — the manager needs the reason.
        <p style={{ color: 'var(--stop)', marginTop: 'var(--s4)' }}>{(decide.error as Error).message}</p>
      ) : null}
    </>
  );
}
