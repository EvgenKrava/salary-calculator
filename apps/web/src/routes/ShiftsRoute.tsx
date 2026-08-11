import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { anyLoading, firstError, Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { Toolbar } from '../ui/Toolbar';
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

  if (anyLoading(shifts, employees, locations)) return <Loading what={t.shifts.title.toLowerCase()} />;
  // Without this, a failed employees/locations query left every name and location reading '—'
  // in a table that otherwise looked fine.
  const loadError = firstError(shifts, employees, locations);
  if (loadError) return <LoadFailure title={t.shifts.couldNotLoad} error={loadError} />;

  const rows = shifts.data ?? [];
  const nameOf = (id: string) => employees.data?.find((e) => e.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? '—';

  /*
   * Worklist ordering: the rows that need a decision first.
   *
   * This is a Worklist, and the archetype "opens with what is wrong"
   * (docs/design/system.md § Page archetypes) — but it opened with every shift ever recorded in
   * API order, so the handful a manager can actually act on were wherever they happened to fall.
   * Within each group, newest first: a request from yesterday matters more than one from a month
   * ago. Sorted into a copy so the query cache is not mutated.
   */
  const pendingFirst = [...rows].sort((a, b) => {
    const aPending = a.status === 'requested' ? 0 : 1;
    const bPending = b.status === 'requested' ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return b.workDate.localeCompare(a.workDate);
  });
  const pendingCount = rows.filter((s) => s.status === 'requested').length;

  return (
    <>
      {/* The count is the reason to be here, so it is stated rather than left to be counted off
          the status column. Zero says so explicitly — a clean worklist is a first-class state. */}
      <Toolbar
        title={t.shifts.title}
        description={pendingCount > 0 ? t.shifts.awaitingDecision(pendingCount) : t.shifts.noneAwaiting}
      />
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
            {pendingFirst.map((s) => (
              <tr key={s.id}>
                {/* Every cell carries its column name: below 640px the header row is hidden and
                    the table stacks, so without these a shift reads as eight bare values. */}
                <Td label={t.common.date}><span className="mono">{formatDate(s.workDate)}</span></Td>
                <Td label={t.common.employee}>{nameOf(s.employeeId)}</Td>
                <Td label={t.common.location}>{locOf(s.locationId)}</Td>
                <Td label={t.shifts.window}><span className="mono">{s.startsAt}–{s.endsAt}</span></Td>
                <NumCell label={t.common.hours}>{shiftHours(s.startsAt, s.endsAt)}</NumCell>
                <Td label={t.common.status}><StatusPill status={s.status} /></Td>
                <Td label={t.shifts.source}>{SOURCE_LABEL[s.source] ?? s.source}</Td>
                <Td label={t.shifts.decision}>
                  {s.status === 'requested' ? (
                    /* `row-actions` + `sm`, matching every other table in the app: full-size
                       buttons push a 40px row apart, and the class is what `table.css` sizes the
                       ДІЇ column against. */
                    <span className="row-actions">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => decide.mutate({ id: s.id, decision: 'approve' })}
                        aria-label={t.shifts.approveFor(nameOf(s.employeeId), formatDate(s.workDate))}
                      >
                        {t.shifts.approve}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => decide.mutate({ id: s.id, decision: 'reject' })}
                        aria-label={t.shifts.rejectFor(nameOf(s.employeeId), formatDate(s.workDate))}
                      >
                        {t.shifts.reject}
                      </Button>
                    </span>
                  ) : null}
                  {/*
                   * The failure sits in the row whose decision failed, not at the foot of the
                   * page. A mutation error here is usually "overlaps an existing approved shift",
                   * which is about one specific shift — printed at the bottom of a 200-row table
                   * it named a reason with nothing to attach it to. `role="status"` because
                   * nothing else on screen changes when a decision is refused.
                   */}
                  {decide.error && decide.variables?.id === s.id ? (
                    <p className="setup__rowError" role="status">{(decide.error as Error).message}</p>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
