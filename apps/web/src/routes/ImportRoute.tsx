import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { MonthSelect } from '../ui/Select';
import { config } from '../lib/config';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { Table, Th, Td } from '../ui/Table';
import { Toolbar } from '../ui/Toolbar';
import { useEmployees, useNameMap, useSetNameMapping } from '../lib/queries';

interface PreviewResult {
  months: number[];
  sourceNames: string[];
  anomalies: string[];
  unmappedNames: string[];
  unknownLocations: number[];
  missingSlots: string[];
  inactiveEmployees: string[];
}

interface CommitResult {
  period: { year: number; month: number };
  created: number;
  skipped: number;
  conflicts: string[];
  windowChanged: string[];
  unmappedNames: string[];
  unknownLocations: number[];
  missingSlots: string[];
  inactiveEmployees: string[];
}

/** A named list of strings/numbers, or nothing if the report array is empty. */
function ReportList({ title, items }: { title: string; items: (string | number)[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--s4)' }}>
      <h3 style={{ fontSize: 'var(--text-base)', marginBottom: 'var(--s1)' }}>{title}</h3>
      <ul className="mono" style={{ margin: 0, paddingLeft: 'var(--s6)', fontSize: 'var(--text-xs)' }}>
        {items.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Map each spreadsheet name to an employee, or mark it as not-a-person.
 *
 * This is the step that makes an import mean anything. The parser deliberately never guesses
 * who gets paid, so an unmapped name yields no shift — the real workbook parses 3,337 cells and
 * resolves NONE of them until these mappings exist. Previously the unmapped names were rendered
 * as a read-only list, which told the manager there was a problem and gave them no way to fix
 * it without hand-writing API calls.
 *
 * "Не людина" (ignored) exists because the sheet contains placeholder rows like `Бариста 1` that
 * are slots, not staff. Marking them keeps them out of the unmapped list permanently instead of
 * re-prompting on every import.
 */
export function NameMapper({ names }: { names: string[] }) {
  const employees = useEmployees();
  const mappings = useNameMap();
  const setMapping = useSetNameMapping();
  const [error, setError] = useState<string | null>(null);

  if (names.length === 0) return null;

  const active = (employees.data ?? []).filter((e) => e.active);
  const mappedFor = (sourceName: string) => (mappings.data ?? []).find((m) => m.sourceName === sourceName);

  async function assign(sourceName: string, value: string) {
    setError(null);
    try {
      if (value === '__ignore__') await setMapping.mutateAsync({ sourceName, ignored: true });
      else if (value === '') await setMapping.mutateAsync({ sourceName, employeeId: null, ignored: false });
      else await setMapping.mutateAsync({ sourceName, employeeId: value, ignored: false });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section style={{ marginTop: 'var(--s4)' }}>
      <h3 style={{ marginBottom: 'var(--s1)' }}>{t.importScreen.mapNamesTitle}</h3>
      <p style={{ marginTop: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>
        {t.importScreen.mapNamesHint}
      </p>
      {employees.error ? (
        <p style={{ color: 'var(--stop)' }}>{t.common.couldNotLoad(t.nav.employees.toLowerCase())}</p>
      ) : (
        <Table caption={t.importScreen.mapNamesTitle}>
          <thead>
            <tr>
              <Th>{t.importScreen.sheetName}</Th>
              <Th>{t.common.employee}</Th>
            </tr>
          </thead>
          <tbody>
            {names.map((n) => {
              const m = mappedFor(n);
              const current = m?.ignored ? '__ignore__' : (m?.employeeId ?? '');
              return (
                <tr key={n}>
                  <Td><span className="mono">{n}</span></Td>
                  <Td>
                    <select
                      className="field__input field__select"
                      aria-label={t.importScreen.mapNameFor(n)}
                      value={current}
                      disabled={setMapping.isPending}
                      onChange={(e) => void assign(n, e.target.value)}
                    >
                      <option value="">{t.importScreen.chooseEmployee}</option>
                      {active.map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                      <option value="__ignore__">{t.importScreen.notAPerson}</option>
                    </select>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
    </section>
  );
}

/**
 * Schedule import: preview a workbook, then commit it for a specific month. The importer's
 * whole contract is that it never guesses at a name, location, or slot it cannot resolve —
 * so every report array below is always shown, even when empty of `created` rows, because
 * hiding `unmappedNames` (say) would defeat the point of the importer surfacing them.
 */
/**
 * The import flow itself, with no page chrome.
 *
 * Extracted from the route so it can live inside a modal on the schedule page — importing a
 * schedule is something a manager does *from* the schedule, not by navigating away from it and
 * losing the month they were looking at.
 */
export function ImportPanel({ onCommitted }: { onCommitted?: () => void } = {}) {
  const { getToken } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [month, setMonth] = useState(String(new Date().getUTCMonth() + 1));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function postMultipart<T>(path: string, extra: Record<string, string>): Promise<T> {
    if (!file) throw new Error(t.importScreen.chooseFileFirst);
    const token = await getToken();
    const form = new FormData();
    form.set('file', file);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const res = await fetch(`${config.apiUrl}${path}`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // Not JSON — keep the status line.
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  async function runPreview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCommitResult(null);
    setBusy(true);
    try {
      const result = await postMultipart<PreviewResult>('/api/schedule-imports/preview', { year });
      setPreview(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    setError(null);
    setBusy(true);
    try {
      const result = await postMultipart<CommitResult>('/api/schedule-imports/commit', { year, month });
      setCommitResult(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Tell the caller a commit landed, so a host screen can refresh (the schedule modal reloads
  // the month rather than showing the manager a calendar that predates their own import).
  const committed = commitResult !== null;
  useEffect(() => {
    if (committed) onCommitted?.();
  }, [committed, onCommitted]);

  return (
    <>
      <form onSubmit={runPreview}>
        <div className="field">
          <label className="field__label" htmlFor="file">{t.importScreen.workbook}</label>
          <input
            id="file"
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>
        <Field label={t.importScreen.year} name="year" type="number" numeric value={year} onChange={(e) => setYear(e.target.value)} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t.importScreen.parsing : t.importScreen.parse}
        </Button>
      </form>

      {error ? <p style={{ color: 'var(--stop)', marginTop: 'var(--s4)' }}>{error}</p> : null}

      {preview ? (
        <div className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s6)' }}>
          <h2>{t.importScreen.previewResult}</h2>
          <p className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
            {t.importScreen.monthsFound(preview.months.join(', ') || '—')}
          </p>
          {/* Unmapped names are the ONLY thing standing between a parsed workbook and real
              shifts, so they get an action rather than a read-only list. */}
          <NameMapper names={preview.unmappedNames} />
          <ReportList title={t.importScreen.unknownLocations} items={preview.unknownLocations} />
          <ReportList title={t.importScreen.missingSlots} items={preview.missingSlots} />
          <ReportList title={t.importScreen.inactiveEmployees} items={preview.inactiveEmployees} />
          <ReportList title={t.importScreen.anomalies} items={preview.anomalies} />

          <div style={{ marginTop: 'var(--s6)' }}>
            <h3 style={{ marginBottom: 'var(--s2)' }}>{t.importScreen.commitHeading}</h3>
            <MonthSelect label={t.importScreen.month} value={month} onChange={setMonth} />
            <Button variant="primary" onClick={runCommit} disabled={busy}>
              {busy ? t.importScreen.committing : t.importScreen.commit}
            </Button>
          </div>
        </div>
      ) : null}

      {commitResult ? (
        <div className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s6)' }}>
          <h2>{t.importScreen.commitResult}</h2>
          <p className="mono" style={{ fontSize: 'var(--text-xs)' }}>
            {t.importScreen.created} {commitResult.created}, {t.importScreen.skipped} {commitResult.skipped}
          </p>
          <ReportList title={t.importScreen.conflicts} items={commitResult.conflicts} />
          <ReportList title={t.importScreen.windowChanged} items={commitResult.windowChanged} />
          <ReportList title={t.importScreen.unmappedNames} items={commitResult.unmappedNames} />
          <ReportList title={t.importScreen.unknownLocations} items={commitResult.unknownLocations} />
          <ReportList title={t.importScreen.missingSlots} items={commitResult.missingSlots} />
          <ReportList title={t.importScreen.inactiveEmployees} items={commitResult.inactiveEmployees} />
        </div>
      ) : null}
    </>
  );
}
