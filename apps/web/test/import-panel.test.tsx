import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnomalyReport } from '../src/routes/ImportRoute';
import { t } from '../src/lib/i18n';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `ImportPanel`'s notification contract.
 *
 * The bug: `onCommitted` was called from a `useEffect` whose dependency array contained the
 * callback itself. Every caller passes an inline arrow, so the identity changed on each render —
 * effect fires, host refetches, host re-renders, new identity, effect fires again. The schedule
 * page died with "Something went wrong!" after every import; reproduced at 51 effect firings for
 * a single mount.
 *
 * The fix is structural: notify from the commit handler, where a discrete event belongs, so
 * there is no dependency array to get wrong. jsdom will not submit a form containing a
 * `required` file input, so the click-through cannot be driven here — these assertions pin the
 * structure that made the loop impossible instead of re-testing React's scheduler.
 */
const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/routes/ImportRoute.tsx'),
  'utf8',
);
// Comments are stripped first: the file explains this very bug in prose, and matching the
// explanation would fail the test that the code is correct.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('ImportPanel notification', () => {
  it('never calls onCommitted from an effect', () => {
    // The specific shape that looped: onCommitted in a dependency array.
    expect(src).not.toMatch(/useEffect\([^)]*onCommitted/s);
    expect(src).not.toMatch(/\[\s*committed\s*,\s*onCommitted\s*\]/);
  });

  it('calls onCommitted from the commit handler, after the result is stored', () => {
    const commitFn = /async function runCommit\(\)[\s\S]*?\n  \}/.exec(src);
    expect(commitFn, 'runCommit not found').not.toBeNull();
    const body = commitFn![0];
    expect(body).toContain('onCommitted?.()');
    // Order matters: the host refetches, so the result must be committed first.
    expect(body.indexOf('setCommitResult')).toBeLessThan(body.indexOf('onCommitted?.()'));
  });

  it('notifies only on a successful commit', () => {
    const body = /async function runCommit\(\)[\s\S]*?\n  \}/.exec(src)![0];
    // Inside the try, before the catch — a failed commit must not trigger a host refetch.
    const notify = body.indexOf('onCommitted?.()');
    const katch = body.indexOf('} catch');
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeLessThan(katch);
  });

  it('does not notify from the preview path, which writes nothing', () => {
    const preview = /async function runPreview\([\s\S]*?\n  \}/.exec(src)![0];
    expect(preview).not.toContain('onCommitted');
  });
});

/**
 * Anomaly rendering.
 *
 * The crash on the real client workbook: `PreviewResult.anomalies` was typed `string[]` while the
 * API had always returned `ParsedAnomaly` OBJECTS, so the list rendered an object as a React child
 * and threw "Minified React error #31" — the import screen died as soon as a preview came back
 * with any anomaly. The real file yields ~2,100, so it failed every single time, and typecheck
 * could not catch it because the declared type was simply wrong.
 *
 * Rendered rather than asserted against source: the failure was a render-time throw, and only a
 * render reproduces it.
 */
describe('anomaly report', () => {
  const anomalies = [
    { kind: 'substitute' as const, sourceName: 'Олег', slot: 1, date: '2026-05-04', raw: 'Світлана' },
    { kind: 'annotation' as const, sourceName: null, slot: 2, date: '2026-05-06', raw: 'інвентаризація' },
    { kind: 'unparsed' as const, sourceName: null, slot: 1, date: '2026-06-31', raw: '2' },
  ];

  it('renders anomaly objects without throwing', () => {
    // The exact shape that produced React error #31.
    expect(() => render(<AnomalyReport anomalies={anomalies} />)).not.toThrow();
  });

  it('groups by kind with a count, so 2,100 annotations cannot bury 148 substitutions', () => {
    render(<AnomalyReport anomalies={anomalies} />);
    expect(screen.getByText(`${t.importScreen.anomalySubstitute} — 1`)).toBeInTheDocument();
    expect(screen.getByText(`${t.importScreen.anomalyAnnotation} — 1`)).toBeInTheDocument();
  });

  it('explains that a substitution is unpaid unless the manager acts', () => {
    // The one anomaly kind with a payroll consequence: the covering person gets no shift row.
    render(<AnomalyReport anomalies={anomalies} />);
    expect(screen.getByText(t.importScreen.anomalySubstituteNote)).toBeInTheDocument();
  });

  it('caps each group and says how many were withheld', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: 'annotation' as const,
      sourceName: null,
      slot: 1,
      date: `2026-05-0${i + 1}`,
      raw: `note ${i}`,
    }));
    render(<AnomalyReport anomalies={many} />);
    // 5 shown, 4 withheld — a silent truncation would read as "that's all of them".
    expect(screen.getByText(t.importScreen.andMore(4))).toBeInTheDocument();
  });

  it('renders nothing when there are no anomalies', () => {
    const { container } = render(<AnomalyReport anomalies={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
