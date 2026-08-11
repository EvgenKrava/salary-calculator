import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { config } from '../lib/config';
import { useAuth } from '../lib/auth';
import { t, MONTHS } from '../lib/i18n';
import { Table, Th, Td } from '../ui/Table';
import { useEmployees, useNameMap, useSetNameMapping } from '../lib/queries';
import './import.css';

interface PreviewResult {
  /**
   * Periods found in the workbook, as {year, month}.
   *
   * This was typed `number[]` while the API had always returned objects, so
   * `preview.months.join(', ')` rendered "[object Object]". It matters more than cosmetically now:
   * the real client sheet is one timeline spanning Травень 2026 → Серпень 2027, so the year is
   * what distinguishes May 2026 from May 2027 and the manager has to be able to pick between them.
   */
  months: { year: number; month: number }[];
  sourceNames: string[];
  /**
   * Cells the parser could not turn into a shift, as objects — NOT strings.
   *
   * This was typed `string[]` while the API had always returned `ParsedAnomaly` objects, so
   * `<ReportList items={preview.anomalies}>` rendered an object as a React child and threw
   * "Minified React error #31" — the import screen died the moment a preview came back with any
   * anomaly at all. The real client workbook produces 2,097 of them, so it crashed every time;
   * the throw was invisible to typecheck because the declared type was a lie.
   */
  anomalies: {
    kind: 'substitute' | 'annotation' | 'unparsed';
    sourceName: string | null;
    slot: number;
    date: string | null;
    raw: string;
  }[];
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

/**
 * A named list of strings/numbers, or nothing if the report array is empty.
 *
 * The same "heading plus mono list" shape was written out four times across this file with its own
 * inline margins each time; it is one class now (`report__*` in import.css).
 */
function ReportList({ title, items }: { title: string; items: (string | number)[] }) {
  if (items.length === 0) return null;
  return (
    <div className="report">
      {/* The count is part of the heading: "2 097 anomalies" and "3 anomalies" call for very
          different reactions, and the old heading made the reader count the list to find out. */}
      <h3 className="report__title">
        {title} <span className="report__count mono">{items.length}</span>
      </h3>
      <ul className="report__list mono">
        {items.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

type Anomaly = PreviewResult['anomalies'][number];

/**
 * Anomalies, grouped by kind with a sample — not 2,097 raw rows.
 *
 * The real workbook produces ~2,100 anomalies, almost all `annotation` (text on a row with no
 * name: meeting notes, inventory reminders). Listing them individually buries the handful that
 * matter — a `substitute` means someone covered a shift and nobody will be paid for it unless the
 * manager acts. So each kind gets a count, an explanation of what it means for payroll, and a few
 * examples rather than the full dump.
 */
export function AnomalyReport({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) return null;

  const KINDS: { kind: Anomaly['kind']; label: string; note: string }[] = [
    { kind: 'substitute', label: t.importScreen.anomalySubstitute, note: t.importScreen.anomalySubstituteNote },
    { kind: 'unparsed', label: t.importScreen.anomalyUnparsed, note: t.importScreen.anomalyUnparsedNote },
    { kind: 'annotation', label: t.importScreen.anomalyAnnotation, note: t.importScreen.anomalyAnnotationNote },
  ];

  return (
    <div className="report">
      <h3 className="report__title">
        {t.importScreen.anomalies} <span className="report__count mono">{anomalies.length}</span>
      </h3>
      {KINDS.map(({ kind, label, note }) => {
        const group = anomalies.filter((a) => a.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="report__group">
            {/* The heading text is asserted verbatim by import-panel.test.tsx — a substitution
                means someone worked and will not be paid, so the count belongs in the label. */}
            <p className="report__groupTitle">
              {label} — {group.length}
            </p>
            <p className="report__note">{note}</p>
            <ul className="report__list mono">
              {group.slice(0, 5).map((a, i) => (
                <li key={`${kind}-${i}`}>
                  {[a.date, a.sourceName, a.raw].filter(Boolean).join(' · ')}
                </li>
              ))}
              {group.length > 5 ? (
                <li className="report__more">{t.importScreen.andMore(group.length - 5)}</li>
              ) : null}
            </ul>
          </div>
        );
      })}
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
    <section className="report">
      <h3 className="report__title">{t.importScreen.mapNamesTitle}</h3>
      <p className="report__note">{t.importScreen.mapNamesHint}</p>
      {employees.error ? (
        <p className="form__error" role="status">{t.common.couldNotLoad(t.nav.employees.toLowerCase())}</p>
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
                  <Td label={t.importScreen.sheetName}><span className="mono">{n}</span></Td>
                  <Td label={t.common.employee}>
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
      {error ? <p className="form__error" role="status">{error}</p> : null}
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
  /**
   * The period to commit, as "YYYY-M", chosen from the periods the preview actually found.
   *
   * Previously a bare month number, decoupled from the file: a workbook spanning two calendar
   * years contains the same month twice (May 2026 and May 2027), and a month-only choice could
   * not say which — the API then imported both and reported the overlap as a conflict.
   */
  const [period, setPeriod] = useState('');
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
      // Default to the first period in the file rather than to today's month, which may not be
      // in the workbook at all.
      const first = result.months[0];
      setPeriod(first ? `${first.year}-${first.month}` : '');
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
      // `year` is the timeline's STARTING year (what the parser needs to date the first block);
      // `targetYear`+`month` are the period being committed. They differ whenever the workbook
      // crosses a year boundary — see the commit route in scheduleImports.ts.
      const [targetYear, month] = period.split('-');
      if (!targetYear || !month) throw new Error(t.importScreen.choosePeriodFirst);
      const result = await postMultipart<CommitResult>('/api/schedule-imports/commit', {
        year,
        targetYear,
        month,
      });
      setCommitResult(result);
      // Notify the host HERE, in the event handler, not from an effect.
      //
      // This was an effect keyed on `[committed, onCommitted]`, and callers pass an inline
      // arrow — so `onCommitted` had a new identity every render, the effect re-ran, its
      // refetch re-rendered the parent, and the schedule page died with "Something went
      // wrong!" after every import. Reproduced at 51 effect firings for a single mount.
      //
      // A commit is a discrete event, so the event handler is where it belongs; there is no
      // dependency array to get wrong.
      onCommitted?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={runPreview}>
        <div className="field field--wide">
          <label className="field__label" htmlFor="file">{t.importScreen.workbook}</label>
          {/* `field__file`: the raw control sat unstyled beside fully styled inputs — the browser
              default is a grey button plus body-face text, which read as the one thing on the form
              that had been forgotten. */}
          <input
            id="file"
            className="field__file"
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

      {error ? <p className="form__error import__error" role="status">{error}</p> : null}

      {preview ? (
        <Card title={t.importScreen.previewResult}>
          <p className="mono report__note">
            {t.importScreen.monthsFound(
              preview.months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`).join(', ') || '—',
            )}
          </p>
          {/* Unmapped names are the ONLY thing standing between a parsed workbook and real
              shifts, so they get an action rather than a read-only list. */}
          <NameMapper names={preview.unmappedNames} />
          <ReportList title={t.importScreen.unknownLocations} items={preview.unknownLocations} />
          <ReportList title={t.importScreen.missingSlots} items={preview.missingSlots} />
          <ReportList title={t.importScreen.inactiveEmployees} items={preview.inactiveEmployees} />
          <AnomalyReport anomalies={preview.anomalies} />

          <div className="import__commit">
            <h3>{t.importScreen.commitHeading}</h3>
            {/* Choose from the periods the file actually contains, not from all twelve months:
                a month that isn't in the workbook imports nothing, and with a two-year timeline
                a bare month number cannot say which year is meant. */}
            <Select
              label={t.importScreen.period}
              name="period"
              size="wide"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              {preview.months.map((m) => (
                <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                  {MONTHS[m.month - 1]} {m.year}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={runCommit} disabled={busy || period === ''}>
              {busy ? t.importScreen.committing : t.importScreen.commit}
            </Button>
          </div>
        </Card>
      ) : null}

      {commitResult ? (
        <Card title={t.importScreen.commitResult} tone="ok">
          {/* The outcome of a write, announced: the modal does not close on commit, so without this
              a screen-reader user gets no signal that the import actually happened. */}
          <p className="mono import__tally" role="status">
            {t.importScreen.created} {commitResult.created}, {t.importScreen.skipped} {commitResult.skipped}
          </p>
          <ReportList title={t.importScreen.conflicts} items={commitResult.conflicts} />
          <ReportList title={t.importScreen.windowChanged} items={commitResult.windowChanged} />
          <ReportList title={t.importScreen.unmappedNames} items={commitResult.unmappedNames} />
          <ReportList title={t.importScreen.unknownLocations} items={commitResult.unknownLocations} />
          <ReportList title={t.importScreen.missingSlots} items={commitResult.missingSlots} />
          <ReportList title={t.importScreen.inactiveEmployees} items={commitResult.inactiveEmployees} />
        </Card>
      ) : null}
    </>
  );
}
