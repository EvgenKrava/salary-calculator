import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { MonthSelect, Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { ApiError } from '../lib/api';
import { t, formatDate, formatTimestampDate } from '../lib/i18n';
import {
  useCreateSalaryRun,
  useSalaryRunPreview,
  useEmployees,
  useLocations,
  useSalaryRuns,
  type Employee,
  type Location,
  type SalaryRunLine,
} from '../lib/queries';

export function RunBreakdown({ lines, employees }: { lines: SalaryRunLine[]; employees: Employee[] }) {
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? '—';
  /**
   * Column totals, not just a grand total.
   *
   * A manager reconciles this against the bank transfer and against the revenue figures, so
   * each component needs its own sum — a single grand total forces them to add a column by
   * hand, which is exactly the arithmetic this screen exists to remove.
   *
   * Summed from the already-rounded line values so the footer equals what is displayed above
   * it; summing raw values first could differ from the visible column by a cent.
   */
  const totals = lines.reduce(
    (acc, l) => ({
      hourlyPay: acc.hourlyPay + l.hourlyPay,
      revenueShare: acc.revenueShare + l.revenueShare,
      bonus: acc.bonus + l.bonus,
      total: acc.total + l.total,
    }),
    { hourlyPay: 0, revenueShare: 0, bonus: 0, total: 0 },
  );
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
          <Td>
            {t.runs.allEmployees} ({lines.length})
          </Td>
          <NumCell><Money value={totals.hourlyPay} /></NumCell>
          <NumCell><Money value={totals.revenueShare} /></NumCell>
          <NumCell><Money value={totals.bonus} /></NumCell>
          <NumCell money><Money value={totals.total} /></NumCell>
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
  const preview = useSalaryRunPreview();
  const now = new Date();
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [half, setHalf] = useState<'1' | '2'>('1');
  // Keyed by employee id, held as strings so a half-typed value is not coerced to a number.
  const [bonusText, setBonusText] = useState<Record<string, string>>({});
  const [gaps, setGaps] = useState<{ employeeId: string; locationId: string; date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SalaryRunLine[] | null>(null);
  /**
   * The dry run currently on screen, and the exact inputs it was computed from.
   *
   * A salary run is final and immediately visible to employees, so the old flow — fill a form,
   * submit, and find out — put an irreversible action behind a blind guess. Now the manager
   * previews, reads the actual figures, and only then commits. `inputs` is kept so an edit to
   * any field invalidates the preview rather than letting someone commit numbers that no
   * longer match what they are looking at.
   */
  const [previewed, setPreviewed] = useState<{
    periodStart: string;
    periodEnd: string;
    lines: SalaryRunLine[];
    gaps: { employeeId: string; locationId: string; date: string }[];
    blocked: boolean;
    inputs: string;
  } | null>(null);

  const activeEmployees = (employees.data ?? []).filter((e) => e.active);

  /**
   * Validate the form and return the request payload, or null with an error shown.
   *
   * Shared by preview and commit so the two cannot disagree about what is valid.
   */
  function readForm(): { year: number; month: number; half: 1 | 2; bonuses: Record<string, number> } | null {
    const yearNum = Number(year);
    const monthNum = Number(month);
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      setError(t.runs.badYear);
      return null;
    }
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      setError(t.runs.badMonth);
      return null;
    }
    const { bonuses, invalid } = parseBonuses(bonusText);
    if (invalid.length > 0) {
      const names = invalid.map((id) => activeEmployees.find((x) => x.id === id)?.name ?? id);
      setError(t.runs.badBonus(names.join(', ')));
      return null;
    }
    return { year: yearNum, month: monthNum, half: half === '1' ? 1 : 2, bonuses };
  }

  /** Fingerprint of the inputs, so editing any field invalidates a stale preview. */
  function fingerprint(body: { year: number; month: number; half: number; bonuses: Record<string, number> }) {
    return JSON.stringify([body.year, body.month, body.half, Object.entries(body.bonuses).sort()]);
  }

  const currentFingerprint = (() => {
    const yearNum = Number(year);
    const monthNum = Number(month);
    const { bonuses } = parseBonuses(bonusText);
    return fingerprint({ year: yearNum, month: monthNum, half: half === '1' ? 1 : 2, bonuses });
  })();

  /** True when the preview on screen still matches the form. */
  const previewIsCurrent = previewed !== null && previewed.inputs === currentFingerprint;

  async function doPreview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGaps(null);
    setResult(null);
    const body = readForm();
    if (!body) return;
    try {
      const out = await preview.mutateAsync(body);
      setPreviewed({ ...out, inputs: fingerprint(body) });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function doCommit() {
    setError(null);
    setGaps(null);
    const body = readForm();
    if (!body) return;
    try {
      const created = await create.mutateAsync(body);
      setResult(created.lines);
      setPreviewed(null);
      setBonusText({});
    } catch (err) {
      // The API returns 409 with { error, gaps } when revenue is incomplete; ApiError.body
      // carries that parsed JSON, so the gaps array is reachable here rather than lost with
      // just the message string.
      const body2 = err instanceof ApiError ? (err.body as { gaps?: typeof gaps } | undefined) : undefined;
      if (body2?.gaps?.length) setGaps(body2.gaps);
      else setError((err as Error).message);
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.runs.title}</h1>

      <form className="panel" style={{ padding: 'var(--s4)', marginBottom: 'var(--s6)' }} onSubmit={doPreview}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>{t.runs.runTitle}</h2>
        <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>{t.runs.hint}</p>
        <Field label={t.runs.year} name="year" type="number" numeric value={year} onChange={(e) => setYear(e.target.value)} />
        <MonthSelect label={t.runs.month} value={month} onChange={setMonth} />
        <Select
          label={t.runs.period}
          name="half"
          size="wide"
          value={half}
          onChange={(e) => setHalf(e.target.value as '1' | '2')}
        >
          <option value="1">{t.runs.firstHalf}</option>
          <option value="2">{t.runs.secondHalf}</option>
        </Select>
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

        {/* Preview is the primary action; committing is deliberately the SECOND step, and only
            becomes available once the manager has seen the figures for the current inputs. */}
        <Button
          type="submit"
          variant="primary"
          disabled={preview.isPending || employees.isLoading || Boolean(employees.error)}
          style={{ marginTop: 'var(--s4)' }}
        >
          {preview.isPending ? t.runs.calculating : t.runs.calculate}
        </Button>
      </form>

      {previewed ? (
        <div style={{ marginBottom: 'var(--s6)' }}>
          <h2 style={{ marginBottom: 'var(--s1)' }}>{t.runs.previewTitle}</h2>
          <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>
            {formatDate(previewed.periodStart)} — {formatDate(previewed.periodEnd)} · {t.runs.previewHint}
          </p>

          {previewed.blocked ? (
            <BlockedRun
              gaps={previewed.gaps}
              employees={employees.data ?? []}
              locations={locations.data ?? []}
            />
          ) : (
            <>
              <RunBreakdown lines={previewed.lines} employees={employees.data ?? []} />
              {previewIsCurrent ? (
                <Button
                  variant="primary"
                  onClick={doCommit}
                  disabled={create.isPending}
                  style={{ marginTop: 'var(--s4)' }}
                >
                  {create.isPending ? t.runs.running : t.runs.confirmRun}
                </Button>
              ) : (
                /* Inputs changed after the preview: committing now would write figures that
                   differ from the ones on screen, which is exactly the mistake this flow
                   exists to prevent. */
                <p style={{ color: 'var(--warn)', marginTop: 'var(--s4)' }}>{t.runs.staleReview}</p>
              )}
            </>
          )}
        </div>
      ) : null}

      {gaps ? (
        <BlockedRun gaps={gaps} employees={employees.data ?? []} locations={locations.data ?? []} />
      ) : null}
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
      {result ? (
        <>
          <h2 style={{ marginBottom: 'var(--s2)' }}>{t.runs.savedTitle}</h2>
          <RunBreakdown lines={result} employees={employees.data ?? []} />
        </>
      ) : null}

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
                {/* created_at is a timestamptz, so it must be CONVERTED to local time, not sliced:
                    a run created at 22:30 UTC on the 5th was already the 6th in Kyiv. */}
                <Td><span className="mono">{formatTimestampDate(String(r.createdAt))}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
