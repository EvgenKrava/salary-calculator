import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { anyLoading, firstError } from '../ui/QueryGate';
import { useEmployees, useLocations, useShiftDecision, useShifts } from '../lib/queries';
import { shiftHours } from '../lib/hours';
import { t, formatDate } from '../lib/i18n';

const SOURCE_LABEL: Record<string, string> = {
  native: t.shifts.sourceNative,
  extracted: t.shifts.sourceExtracted,
  imported: t.shifts.sourceImported,
};

export function ShiftsRoute() {
  const shifts = useShifts();
  const employees = useEmployees();
  const locations = useLocations();
  const decide = useShiftDecision();

  if (anyLoading(shifts, employees, locations)) return <p className="mono">{t.common.loading}</p>;
  // Without this, a failed employees/locations query left every name and location reading '—'
  // in a table that otherwise looked fine.
  const loadError = firstError(shifts, employees, locations);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>{t.shifts.couldNotLoad}</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
      </div>
    );
  }

  const rows = shifts.data ?? [];
  const nameOf = (id: string) => employees.data?.find((e) => e.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? '—';

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.shifts.title}</h1>
      {rows.length === 0 ? (
        <EmptyState title={t.shifts.empty} action={t.shifts.emptyAction} />
      ) : (
        <Table caption={t.shifts.title}>
          <thead>
            <tr>
              <Th>{t.common.date}</Th>
              <Th>{t.common.employee}</Th>
              <Th>{t.common.location}</Th>
              <Th>{t.shifts.window}</Th>
              <Th numeric>{t.common.hours}</Th>
              <Th>{t.common.status}</Th>
              <Th>{t.shifts.source}</Th>
              <Th>{t.shifts.decision}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td><span className="mono">{formatDate(s.workDate)}</span></Td>
                <Td>{nameOf(s.employeeId)}</Td>
                <Td>{locOf(s.locationId)}</Td>
                <Td><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                <NumCell>{shiftHours(s.startsAt, s.endsAt)}</NumCell>
                <Td><StatusPill status={s.status} /></Td>
                <Td>{SOURCE_LABEL[s.source] ?? s.source}</Td>
                <Td>
                  {s.status === 'requested' ? (
                    <span style={{ display: 'flex', gap: 'var(--s1)' }}>
                      <Button
                        variant="primary"
                        onClick={() => decide.mutate({ id: s.id, decision: 'approve' })}
                      >
                        {t.shifts.approve}
                      </Button>
                      <Button variant="danger" onClick={() => decide.mutate({ id: s.id, decision: 'reject' })}>
                        {t.shifts.reject}
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
