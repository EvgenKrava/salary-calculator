import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { config } from '../lib/config';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

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
 * Schedule import: preview a workbook, then commit it for a specific month. The importer's
 * whole contract is that it never guesses at a name, location, or slot it cannot resolve —
 * so every report array below is always shown, even when empty of `created` rows, because
 * hiding `unmappedNames` (say) would defeat the point of the importer surfacing them.
 */
export function ImportRoute() {
  const { getToken } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [month, setMonth] = useState(String(new Date().getUTCMonth() + 1));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function postMultipart<T>(path: string, extra: Record<string, string>): Promise<T> {
    if (!file) throw new Error('Choose a workbook file first.');
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

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.importScreen.title}</h1>

      <form className="panel" style={{ padding: 'var(--s4)' }} onSubmit={runPreview}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>{t.importScreen.preview}</h2>
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
          {busy ? 'Reading…' : 'Preview'}
        </Button>
      </form>

      {error ? <p style={{ color: 'var(--stop)', marginTop: 'var(--s4)' }}>{error}</p> : null}

      {preview ? (
        <div className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s6)' }}>
          <h2>{t.importScreen.previewResult}</h2>
          <p className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)' }}>
            months found: {preview.months.join(', ') || '—'}
          </p>
          <ReportList title={t.importScreen.unmappedNames} items={preview.unmappedNames} />
          <ReportList title={t.importScreen.unknownLocations} items={preview.unknownLocations} />
          <ReportList title={t.importScreen.missingSlots} items={preview.missingSlots} />
          <ReportList title={t.importScreen.inactiveEmployees} items={preview.inactiveEmployees} />
          <ReportList title={t.importScreen.anomalies} items={preview.anomalies} />

          <div style={{ marginTop: 'var(--s6)' }}>
            <h3 style={{ marginBottom: 'var(--s2)' }}>{t.importScreen.commitHeading}</h3>
            <Field label={t.importScreen.month} name="month" type="number" min="1" max="12" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
            <Button variant="primary" onClick={runCommit} disabled={busy}>
              {busy ? 'Committing…' : 'Commit'}
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
