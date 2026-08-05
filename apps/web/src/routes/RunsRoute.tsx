import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import { ApiError } from '../lib/api';
import { t, formatDate } from '../lib/i18n';
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
    <Table caption={t.runs.breakdown}>
      <thead>
        <tr>
          <Th>{t.common.employee}</Th>
          <Th numeric>{t.runs.hourly}</Th>
          <Th numeric>{t.runs.revenueShare}</Th>
          <Th numeric>{t.runs.bonusColumn}</Th>
          <Th numeric>{t.common.total}</Th>
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
          <Td>{t.runs.allEmployees}</Td>
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
      <h2 style={{ color: 'var(--stop)', marginBottom: 'var(--s2)' }}>{t.runs.blockedTitle}</h2>
      <p style={{ marginTop: 0, color: 'var(--ink-muted)' }}>{t.runs.blockedHint}</p>
      <ul className="mono" style={{ margin: 0, paddingLeft: 'var(--s6)' }}>
        {[...byDay.values()].map((g) => (
          <li key={`${g.locationId}-${g.date}`}>
            {formatDate(g.date)} — {t.common.location.toLowerCase()} {locOf(g.locationId)} ({g.who.join(', ')})
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Parse a bonus field. Blank means no bonus; anything unparseable is rejected, not zeroed. */
export function parseBonuses(raw: Record<string, string>): { bonuses: Record<string, number>; invalid: string[] } {
  const bonuses: Record<string, number> = {};
  const invalid: string[] = [];
  for (const [employeeId, text] of Object.entries(raw)) {
    const trimmed = text.trim();
    if (trimmed === '') continue; // blank = no bonus, not a zero to send
    const value = Number(trimmed);
    // The API requires a non-negative number. Catching it here names the employee whose
    // field is wrong, instead of surfacing a generic 400 with no indication of which row.
    if (!Number.isFinite(value) || value < 0) invalid.push(employeeId);
    else if (value > 0) bonuses[employeeId] = value;
  }
  return { bonuses, invalid };
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
  // Keyed by employee id, held as strings so a half-typed value is not coerced to a number.
  const [bonusText, setBonusText] = useState<Record<string, string>>({});
  const [gaps, setGaps] = useState<{ employeeId: string; locationId: string; date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SalaryRunLine[] | null>(null);

  const activeEmployees = (employees.data ?? []).filter((e) => e.active);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGaps(null);
    setResult(null);

    // A run is final and immediately visible to employees, so validate before sending rather
    // than letting a typo become a permanent line.
    const yearNum = Number(year);
    const monthNum = Number(month);
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      setError(t.runs.badYear);
      return;
    }
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      setError(t.runs.badMonth);
      return;
    }
    const { bonuses, invalid } = parseBonuses(bonusText);
    if (invalid.length > 0) {
      const names = invalid.map((id) => activeEmployees.find((x) => x.id === id)?.name ?? id);
      setError(t.runs.badBonus(names.join(', ')));
      return;
    }

    try {
      const created = await create.mutateAsync({
        year: yearNum,
        month: monthNum,
        half: half === '1' ? 1 : 2,
        bonuses,
      });
      setResult(created.lines);
      setBonusText({});
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
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.runs.title}</h1>

      <form className="panel" style={{ padding: 'var(--s4)', marginBottom: 'var(--s6)' }} onSubmit={run}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>{t.runs.runTitle}</h2>
        <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>{t.runs.hint}</p>
        <Field label={t.runs.year} name="year" type="number" numeric value={year} onChange={(e) => setYear(e.target.value)} />
        <Field label={t.runs.month} name="month" type="number" min="1" max="12" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
        <div className="field">
          <label className="field__label" htmlFor="half">{t.runs.period}</label>
          <select id="half" className="field__input" value={half} onChange={(e) => setHalf(e.target.value as '1' | '2')}>
            <option value="1">{t.runs.firstHalf}</option>
            <option value="2">{t.runs.secondHalf}</option>
          </select>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 'var(--s6) 0 0' }}>
          <legend style={{ font: 'inherit', fontWeight: 600, padding: 0, marginBottom: 'var(--s1)' }}>
            {t.runs.bonusesTitle}
          </legend>
          <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>{t.runs.bonusesHint}</p>
          {employees.isLoading ? (
            <p className="mono">{t.runs.loadingEmployees}</p>
          ) : employees.error ? (
            // Never render an empty bonus list as if nobody qualified — a manager would run
            // payroll believing there was nothing to enter.
            <p style={{ color: 'var(--stop)' }}>{t.runs.employeesFailed}</p>
          ) : activeEmployees.length === 0 ? (
            <p className="mono">{t.runs.noActive}</p>
          ) : (
            <Table caption={t.runs.bonusPerEmployeeCaption}>
              <thead>
                <tr>
                  <Th>{t.common.employee}</Th>
                  <Th numeric>{t.runs.bonusColumn}</Th>
                </tr>
              </thead>
              <tbody>
                {activeEmployees.map((emp) => (
                  <tr key={emp.id}>
                    <Td>{emp.name}</Td>
                    <NumCell>
                      <input
                        className="field__input"
                        style={{ textAlign: 'right', maxWidth: '10ch' }}
                        type="text"
                        inputMode="decimal"
                        aria-label={t.runs.bonusFor(emp.name)}
                        value={bonusText[emp.id] ?? ''}
                        onChange={(ev) => setBonusText((prev) => ({ ...prev, [emp.id]: ev.target.value }))}
                      />
                    </NumCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </fieldset>

        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || employees.isLoading || Boolean(employees.error)}
          style={{ marginTop: 'var(--s4)' }}
        >
          {create.isPending ? t.runs.running : t.runs.run}
        </Button>
      </form>

      {gaps ? (
        <BlockedRun gaps={gaps} employees={employees.data ?? []} locations={locations.data ?? []} />
      ) : null}
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
      {result ? <RunBreakdown lines={result} employees={employees.data ?? []} /> : null}

      <h2 style={{ margin: 'var(--s8) 0 var(--s4)' }}>{t.runs.pastRuns}</h2>
      {(runs.data ?? []).length === 0 ? (
        <EmptyState title={t.runs.noRuns} action={t.runs.noRunsAction} />
      ) : (
        <Table caption={t.runs.completedRunsCaption}>
          <thead>
            <tr>
              <Th>{t.runs.periodStart}</Th>
              <Th>{t.runs.periodEnd}</Th>
              <Th>{t.runs.created}</Th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id}>
                <Td><span className="mono">{formatDate(r.periodStart)}</span></Td>
                <Td><span className="mono">{formatDate(r.periodEnd)}</span></Td>
                <Td><span className="mono">{formatDate(String(r.createdAt))}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
