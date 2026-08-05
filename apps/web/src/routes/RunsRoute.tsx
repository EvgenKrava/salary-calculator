import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import { ApiError } from '../lib/api';
import {
  useCreateSalaryRun,
  useEmployees,
  useLocations,
  useSalaryRuns,
  type Employee,
  type Location,
  type SalaryRunLine,
} from '../lib/queries';

export function RunBreakdown({ lines, employees }: { lines: SalaryRunLine[]; employees: Employee[] }) {
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? '—';
  const grand = lines.reduce((sum, l) => sum + l.total, 0);
  return (
    <Table caption="Pay breakdown">
      <thead>
        <tr>
          <Th>Employee</Th>
          <Th numeric>Hourly</Th>
          <Th numeric>Revenue share</Th>
          <Th numeric>Bonus</Th>
          <Th numeric>Total</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.employeeId}>
            <Td>{nameOf(l.employeeId)}</Td>
            <NumCell><Money value={l.hourlyPay} /></NumCell>
            <NumCell><Money value={l.revenueShare} /></NumCell>
            <NumCell><Money value={l.bonus} /></NumCell>
            <NumCell money><Money value={l.total} /></NumCell>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <Td>All employees</Td>
          <NumCell /><NumCell /><NumCell />
          <NumCell money><Money value={grand} /></NumCell>
        </tr>
      </tfoot>
    </Table>
  );
}

/**
 * A blocked run is not an error message — it is a worklist. The API tells us exactly which
 * location-days have no approved revenue, and those are the manager's next actions, so we
 * name every one of them.
 */
export function BlockedRun({
  gaps,
  employees,
  locations,
}: {
  gaps: { employeeId: string; locationId: string; date: string }[];
  employees: Employee[];
  locations: Location[];
}) {
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '—';
  // One missing revenue day affects every person who worked it; group so the manager sees
  // days to fix, not a repeated list of names.
  const byDay = new Map<string, { date: string; locationId: string; who: string[] }>();
  for (const g of gaps) {
    const key = `${g.locationId}|${g.date}`;
    const entry = byDay.get(key) ?? { date: g.date, locationId: g.locationId, who: [] };
    entry.who.push(nameOf(g.employeeId));
    byDay.set(key, entry);
  }

  return (
    <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
      <h2 style={{ color: 'var(--stop)', marginBottom: 'var(--s2)' }}>Run blocked — revenue missing</h2>
      <p style={{ marginTop: 0, color: 'var(--ink-muted)' }}>
        Add approved revenue for each day below, then run payroll again. Nothing has been saved.
      </p>
      <ul className="mono" style={{ margin: 0, paddingLeft: 'var(--s6)' }}>
        {[...byDay.values()].map((g) => (
          <li key={`${g.locationId}-${g.date}`}>
            {g.date} — location {locOf(g.locationId)} ({g.who.join(', ')})
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RunsRoute() {
  const runs = useSalaryRuns();
  const employees = useEmployees();
  const locations = useLocations();
  const create = useCreateSalaryRun();
  const now = new Date();
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [half, setHalf] = useState<'1' | '2'>('1');
  const [gaps, setGaps] = useState<{ employeeId: string; locationId: string; date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SalaryRunLine[] | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGaps(null);
    setResult(null);
    try {
      const created = await create.mutateAsync({
        year: Number(year),
        month: Number(month),
        half: half === '1' ? 1 : 2,
      });
      setResult(created.lines);
    } catch (err) {
      // The API returns 409 with { error, gaps } when revenue is incomplete; ApiError.body
      // carries that parsed JSON, so the gaps array is reachable here rather than lost with
      // just the message string.
      const body = err instanceof ApiError ? (err.body as { gaps?: typeof gaps } | undefined) : undefined;
      if (body?.gaps?.length) setGaps(body.gaps);
      else setError((err as Error).message);
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>Salary runs</h1>

      <form className="panel" style={{ padding: 'var(--s4)', marginBottom: 'var(--s6)' }} onSubmit={run}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>Run payroll</h2>
        <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>
          A run is final and immediately visible to employees. Periods are the 1st–15th and the
          16th–end of month.
        </p>
        <Field label="Year" name="year" type="number" numeric value={year} onChange={(e) => setYear(e.target.value)} />
        <Field label="Month" name="month" type="number" min="1" max="12" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
        <div className="field">
          <label className="field__label" htmlFor="half">Period</label>
          <select id="half" className="field__input" value={half} onChange={(e) => setHalf(e.target.value as '1' | '2')}>
            <option value="1">1st – 15th</option>
            <option value="2">16th – end of month</option>
          </select>
        </div>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Running…' : 'Run payroll'}
        </Button>
      </form>

      {gaps ? (
        <BlockedRun gaps={gaps} employees={employees.data ?? []} locations={locations.data ?? []} />
      ) : null}
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
      {result ? <RunBreakdown lines={result} employees={employees.data ?? []} /> : null}

      <h2 style={{ margin: 'var(--s8) 0 var(--s4)' }}>Past runs</h2>
      {(runs.data ?? []).length === 0 ? (
        <EmptyState title="No payroll has been run yet." action="Use the form above once revenue and shifts are in." />
      ) : (
        <Table caption="Completed runs">
          <thead>
            <tr>
              <Th>Period start</Th>
              <Th>Period end</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id}>
                <Td><span className="mono">{r.periodStart}</span></Td>
                <Td><span className="mono">{r.periodEnd}</span></Td>
                <Td><span className="mono">{String(r.createdAt).slice(0, 10)}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
