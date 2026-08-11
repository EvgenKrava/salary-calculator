import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Card } from '../ui/Card';
import { Toolbar } from '../ui/Toolbar';
import { Figure } from '../ui/Figure';
import { MonthSelect, Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/QueryGate';
import { ApiError } from '../lib/api';
import { t, formatDate, formatTimestampDate } from '../lib/i18n';
import {
  useCreateSalaryRun,
  useSalaryRunPreview,
  useEmployees,
  useLevels,
  useLocations,
  useSalaryRuns,
  type Employee,
  type Level,
  type Location,
  type SalaryRunLine,
} from '../lib/queries';
import './runs.css';

export function RunBreakdown({
  lines,
  employees,
  period,
}: {
  lines: SalaryRunLine[];
  employees: Employee[];
  /** Shown under the display total, e.g. "05.05.2026 — 04.06.2026". Omitted in the saved view. */
  period?: string;
}) {
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
    <>
      {/*
       * The payroll total in display numerals — the single figure a manager opens this screen
       * for, and the one they reconcile against the bank transfer. Per
       * docs/design/system.md § Display numerals there is exactly one per screen, which is why
       * the column totals below stay at body size.
       */}
      <div className="ledger__head">
        <Figure
          value={totals.total.toFixed(2)}
          unit={t.common.currency}
          label={period ? `${t.runs.payrollTotal} · ${period}` : t.runs.payrollTotal}
        />
        <p className="muted">{`${t.runs.allEmployees} (${lines.length})`}</p>
      </div>

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
            <Td label={t.common.employee}>{nameOf(l.employeeId)}</Td>
            <NumCell label={t.runs.hourly}><Money value={l.hourlyPay} /></NumCell>
            <NumCell label={t.runs.revenueShare}><Money value={l.revenueShare} /></NumCell>
            <NumCell label={t.runs.bonusColumn}><Money value={l.bonus} /></NumCell>
            <NumCell money label={t.common.total}><Money value={l.total} /></NumCell>
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
    </>
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
    <Card tone="stop" title={t.runs.blockedTitle} description={t.runs.blockedHint}>
      {/*
       * Each missing day is a LINK to the revenue screen that fixes it.
       *
       * This is the design system's own canonical blocked state — "a blocked salary run lists the
       * missing location-days as links, because that is the manager's next action"
       * (docs/design/system.md § Empty vs blocked) — and it was the one that did not comply: a
       * plain bulleted list, while `MissingRates` beside it had done this correctly all along. A
       * manager who has just been told payroll will not run should not then have to go find the
       * screen.
       */}
      <ul className="blocker__list">
        {[...byDay.values()].map((g) => (
          <li key={`${g.locationId}-${g.date}`}>
            <Link
              to="/revenue"
              className="blocker__link"
              aria-label={t.runs.fixRevenueFor(formatDate(g.date), locOf(g.locationId))}
            >
              <span className="blocker__what">
                <span className="mono">{formatDate(g.date)}</span>
                <span className="blocker__where">
                  {t.common.location.toLowerCase()} {locOf(g.locationId)} ({g.who.join(', ')})
                </span>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The other blocker: a (level, location) combination with nobody's pay configured for it.
 *
 * It stops a run exactly like a missing revenue day, and it needs the same treatment — name the
 * blocker and link to it (docs/design/system.md § Empty vs blocked). Two things make this more
 * than a message:
 *
 * - **Names, not ids.** The API sends `{levelId, locationId}`; a manager cannot act on
 *   "lv1 — loc2". The names come from the levels/locations lists this screen already loads, so
 *   resolving them costs no extra request.
 * - **A link per line.** The fix is one specific screen, and a manager who has just been told
 *   their payroll will not run should not have to go find it.
 */
export function MissingRates({
  missing,
  levels,
  locations,
}: {
  missing: { levelId: string; locationId: string }[];
  levels: Level[];
  locations: Location[];
}) {
  /*
   * An unresolvable id still gets a line.
   *
   * Falling back to '—' rather than dropping the row: a level deleted between the run attempt
   * and this render is a real (if rare) state, and silently showing fewer blockers than the API
   * reported would have the manager fix everything listed and get refused again.
   */
  const levelOf = (id: string) => levels.find((l) => l.id === id)?.name ?? '—';
  const locOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '—';

  return (
    <Card tone="stop" title={t.payMatrix.missingTitle} description={t.payMatrix.missingHint}>
      <ul className="blocker__list">
        {missing.map((m) => {
          const label = t.payMatrix.missingCell(levelOf(m.levelId), locOf(m.locationId));
          return (
            <li key={`${m.levelId}-${m.locationId}`}>
              <Link
                to="/setup"
                className="blocker__link"
                aria-label={t.payMatrix.missingCellLink(levelOf(m.levelId), locOf(m.locationId))}
              >
                <span className="mono">{label}</span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
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
  // Read so a `missingRates` id pair can be named. Cached by React Query — the setup and
  // employees screens read the same key, so this is not an extra round trip in practice.
  const levels = useLevels();
  const create = useCreateSalaryRun();
  const preview = useSalaryRunPreview();
  const now = new Date();
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [half, setHalf] = useState<'1' | '2'>('1');
  // Keyed by employee id, held as strings so a half-typed value is not coerced to a number.
  const [bonusText, setBonusText] = useState<Record<string, string>>({});
  const [gaps, setGaps] = useState<{ employeeId: string; locationId: string; date: string }[] | null>(null);
  /**
   * Unconfigured pay cells from a refused COMMIT.
   *
   * Held separately from `gaps` because they are independent causes: a period can be blocked by
   * either, or both, and a manager who fixes only the one they were shown comes straight back to
   * a second refusal.
   */
  const [missingRates, setMissingRates] = useState<{ levelId: string; locationId: string }[] | null>(null);
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
    missingRates: { levelId: string; locationId: string }[];
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
    setMissingRates(null);
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
    setMissingRates(null);
    const body = readForm();
    if (!body) return;
    try {
      const created = await create.mutateAsync(body);
      setResult(created.lines);
      setPreviewed(null);
      setBonusText({});
    } catch (err) {
      /*
       * The API returns 409 with { error, gaps, missingRates } when the period cannot be run;
       * ApiError.body carries that parsed JSON, so both worklists are reachable here rather than
       * lost with just the message string.
       *
       * A clean preview does not make this branch dead: the matrix is shared state, so an admin
       * clearing a cell between preview and commit is enough to reach it, and `missingRates` is
       * then the only thing that explains the refusal.
       */
      const refused =
        err instanceof ApiError
          ? (err.body as { gaps?: typeof gaps; missingRates?: typeof missingRates } | undefined)
          : undefined;
      if (refused?.gaps?.length) setGaps(refused.gaps);
      if (refused?.missingRates?.length) setMissingRates(refused.missingRates);
      // Only fall back to the raw message when neither worklist explains the failure — otherwise
      // the API's English error prints alongside the Ukrainian explanation of the same thing.
      if (!refused?.gaps?.length && !refused?.missingRates?.length) setError((err as Error).message);
    }
  }

  return (
    <>
      <Toolbar title={t.runs.title} />

      <form onSubmit={doPreview}>
        <Card title={t.runs.runTitle} description={t.runs.hint}>
        {/* Period selectors sit on one row — three stacked full-width fields for year, month
            and half read as a long form when they are really one choice. */}
        <div className="field-row">
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
        </div>
        {/* `.fieldset` / `.fieldset__legend` from field.css — the primitive that existed for this
            and was dead because this, its only caller, inlined the same three declarations. */}
        <fieldset className="fieldset">
          <legend className="fieldset__legend">{t.runs.bonusesTitle}</legend>
          <p className="muted">{t.runs.bonusesHint}</p>
          {employees.isLoading ? (
            <Loading what={t.nav.employees.toLowerCase()} />
          ) : employees.error ? (
            // Never render an empty bonus list as if nobody qualified — a manager would run
            // payroll believing there was nothing to enter.
            <p className="form__error" role="status">{t.runs.employeesFailed}</p>
          ) : activeEmployees.length === 0 ? (
            /*
             * Not mono, and not adjacent to the CTA by accident. In mono directly above the
             * primary button this read as an error message beside an enabled control — while
             * "Порахувати" stayed clickable on a run that has nobody to pay. It is now a plain
             * hint, and the button below is disabled for the same condition.
             */
            <p className="muted">{t.runs.noActive}</p>
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
                    <Td label={t.common.employee}>{emp.name}</Td>
                    <NumCell label={t.runs.bonusColumn}>
                      {/*
                       * `mono` and `--money` sized: this is a money figure being typed, and it was
                       * rendering in the UI sans face — the one input in the app holding an amount
                       * that becomes someone's pay, set in the face the system reserves for prose.
                       */}
                      <input
                        className="field__input field__input--money mono"
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
            block
            // Also disabled with no active employees: the button sat enabled on a run that had
            // nobody to pay, so the only feedback was a mono line that looked like an error.
            disabled={
              preview.isPending ||
              employees.isLoading ||
              Boolean(employees.error) ||
              activeEmployees.length === 0
            }
          >
            {preview.isPending ? t.runs.calculating : t.runs.calculate}
          </Button>
        </Card>
      </form>

      {previewed ? (
        <section className="runs__preview">
          <h2 className="runs__previewTitle">{t.runs.previewTitle}</h2>
          <p className="muted runs__previewPeriod">
            {formatDate(previewed.periodStart)} — {formatDate(previewed.periodEnd)} · {t.runs.previewHint}
          </p>

          {previewed.blocked ? (
            /*
             * Two independent blockers, and only the ones that actually apply are shown.
             *
             * Rendering `BlockedRun` unconditionally — as this did when revenue was the only way
             * to block a run — printed "Розрахунок заблоковано — немає виручки" over an empty
             * list whenever the real cause was unconfigured pay, sending the manager to fix days
             * that were already complete.
             */
            <>
              {previewed.gaps.length > 0 ? (
                <BlockedRun
                  gaps={previewed.gaps}
                  employees={employees.data ?? []}
                  locations={locations.data ?? []}
                />
              ) : null}
              {previewed.missingRates.length > 0 ? (
                <MissingRates
                  missing={previewed.missingRates}
                  levels={levels.data ?? []}
                  locations={locations.data ?? []}
                />
              ) : null}
              {/* Blocked with no cause named: unreachable today, but the alternative is a
                  preview heading over an empty screen and no commit button. */}
              {previewed.gaps.length === 0 && previewed.missingRates.length === 0 ? (
                <Card tone="stop" title={t.common.statusBlocked}>
                  <p className="runs__blockedUnknown">{t.runs.blockedUnknown}</p>
                </Card>
              ) : null}
            </>
          ) : (
            <>
              <RunBreakdown
                lines={previewed.lines}
                employees={employees.data ?? []}
                period={`${formatDate(previewed.periodStart)} — ${formatDate(previewed.periodEnd)}`}
              />
              {previewIsCurrent ? (
                <Button
                  variant="primary"
                  onClick={doCommit}
                  disabled={create.isPending}
                  className="runs__commit"
                >
                  {create.isPending ? t.runs.running : t.runs.confirmRun}
                </Button>
              ) : (
                /* Inputs changed after the preview: committing now would write figures that
                   differ from the ones on screen, which is exactly the mistake this flow
                   exists to prevent. Announced, because the commit button DISAPPEARS when this
                   appears — a control vanishing with no explanation reads as a broken screen. */
                <p className="runs__stale" role="status">{t.runs.staleReview}</p>
              )}
            </>
          )}
        </section>
      ) : null}

      {gaps ? (
        <BlockedRun gaps={gaps} employees={employees.data ?? []} locations={locations.data ?? []} />
      ) : null}
      {missingRates ? (
        <MissingRates
          missing={missingRates}
          levels={levels.data ?? []}
          locations={locations.data ?? []}
        />
      ) : null}
      {error ? <p className="form__error" role="status">{error}</p> : null}
      {result ? (
        <section>
          {/* The one irreversible action in the product has completed, so it is announced. */}
          <h2 role="status">{t.runs.savedTitle}</h2>
          <RunBreakdown lines={result} employees={employees.data ?? []} />
        </section>
      ) : null}

      <h2>{t.runs.pastRuns}</h2>
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
                <Td label={t.runs.periodStart}><span className="mono">{formatDate(r.periodStart)}</span></Td>
                <Td label={t.runs.periodEnd}><span className="mono">{formatDate(r.periodEnd)}</span></Td>
                {/* created_at is a timestamptz, so it must be CONVERTED to local time, not sliced:
                    a run created at 22:30 UTC on the 5th was already the 6th in Kyiv. */}
                <Td label={t.runs.created}>
                  <span className="mono">{formatTimestampDate(String(r.createdAt))}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
