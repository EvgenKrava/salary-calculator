import { useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { anyLoading, firstError, Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { useRole } from '../lib/auth';
import {
  useClearPayRate,
  useLevels,
  useLocations,
  usePayRates,
  useSetPayRate,
  type Level,
  type Location,
  type PayRateDto,
} from '../lib/queries';
import { blank, formatPercent, parsePercent, parseRate } from '../lib/pay';
import { t } from '../lib/i18n';
import './payMatrix.css';

/**
 * The (level, location) pay matrix — what a day of work is worth, per level, per café.
 *
 * **Why a matrix and not a list of fields.** The same level is paid differently at different
 * locations, so the data is genuinely two-dimensional; laying it out as a flat list of
 * level×location pairs would hide the one question an admin actually asks here — *is every
 * combination covered?* A grid answers that by shape: a gap is visible without reading a single
 * figure. Every configured cell is one row of `pay_rates`, and an ABSENT cell blocks payroll for
 * that combination outright.
 *
 * **Unconfigured is a first-class state, and it is muted, not red.** A gap here does block a
 * run, but `--stop` is reserved for a run that is *actually* blocked right now
 * (docs/design/system.md § Color) — painting a fresh, never-configured matrix entirely red would
 * spend the app's loudest signal on the ordinary state of a screen an admin has just opened. The
 * blocked run itself says it in `--stop`, on the Runs screen, where it is true.
 *
 * **Archetype: Form** (§ Page archetypes) — labelled fields, admin setup, never dense. Its core
 * is a table because the data is a grid, but the cells are inputs rather than figures, so it
 * takes the Form archetype's spacing rather than the Ledger's `--row-h` rows. There is no
 * display figure: no single number here is "the answer" the admin came for.
 */
export function PayMatrixPanel() {
  const { isAdmin } = useRole();
  /*
   * Gate BEFORE the hooks that read, so a manager's browser never issues the request.
   *
   * Reads are manager+admin server-side (a manager needs to know what a shift will pay), but
   * writes are admin-only — so rendering this panel for a manager would offer a grid of controls
   * that 403 on touch. That reads as a broken app rather than as one they lack the role for, and
   * the honest fix is for the panel not to exist for them. React's rules allow the early return
   * because `useRole` cannot change identity for a given signed-in session without a remount.
   */
  if (!isAdmin) return null;
  return <PayMatrix />;
}

function PayMatrix() {
  const levels = useLevels();
  const locations = useLocations();
  const rates = usePayRates();

  if (anyLoading(levels, locations, rates)) return <Loading what={t.payMatrix.title.toLowerCase()} />;

  /*
   * A failed read is NOT an empty matrix.
   *
   * `rates.data ?? []` would render every cell as "не задано" over pay that is configured and
   * live — inviting an admin to retype figures that already exist, and telling them a run is
   * blocked when it is not. Empty and unknown are different facts (see ui/QueryGate).
   */
  const loadError = firstError(levels, locations, rates);
  if (loadError) return <LoadFailure what={t.payMatrix.title.toLowerCase()} error={loadError} />;

  const levelRows = levels.data ?? [];
  const locationCols = locations.data ?? [];
  const configured = rates.data ?? [];

  return (
    <Card title={t.payMatrix.title} description={t.payMatrix.hint} flush={levelRows.length > 0}>
      {levelRows.length === 0 || locationCols.length === 0 ? (
        // Not an error and not a blocker — there is simply nothing to configure pay FOR yet, and
        // the fix is on this same screen, above.
        <EmptyState title={t.payMatrix.needsSetup} action={t.payMatrix.needsSetupAction} />
      ) : (
        <div className="table-wrap">
          <table className="matrix">
            <caption className="table__caption">{t.payMatrix.caption}</caption>
            <thead>
              <tr>
                {/* Empty corner: the row headers are levels, the column headers locations. */}
                <td className="matrix__corner" />
                {locationCols.map((loc) => (
                  <th key={loc.id} scope="col" className="matrix__colhead">
                    {loc.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {levelRows.map((level) => (
                <tr key={level.id}>
                  <th scope="row" className="matrix__rowhead">
                    {level.name}
                  </th>
                  {locationCols.map((loc) => (
                    <td
                      key={loc.id}
                      /*
                       * The unconfigured wash lives on the <td> so it fills the row's height
                       * whatever the tallest cell in it turns out to be — see payMatrix.css for
                       * the inner-element version that could not.
                       */
                      className={
                        cellFor(configured, level.id, loc.id)
                          ? 'matrix__cellwrap'
                          : 'matrix__cellwrap matrix__cellwrap--unset'
                      }
                      data-label={loc.name}
                    >
                      <PayCell level={level} location={loc} rate={cellFor(configured, level.id, loc.id)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * The configured cell for a (level, location) pair, if there is one.
 *
 * GET returns a SPARSE list — only configured cells — so an absent entry is the unconfigured
 * state, which is what blocks payroll for that combination.
 */
function cellFor(rates: PayRateDto[], levelId: string, locationId: string) {
  return rates.find((r) => r.levelId === levelId && r.locationId === locationId);
}

/** The stored cell rendered as the two strings its inputs hold, or two empty boxes. */
function displayed(rate: PayRateDto | undefined) {
  return {
    // Money formatting per ui/Money: exactly 2 decimals, no grouping, so the figure is
    // copy-pasteable into a spreadsheet and diffable against the bank.
    rate: rate ? rate.ratePerDay.toFixed(2) : '',
    percent: rate ? formatPercent(rate.revenuePercent) : '',
  };
}

/**
 * One cell: a day rate and a revenue percent, committed together.
 *
 * **The cell commits as a unit, on leaving it — not per field.** `PUT /api/pay-rates` takes the
 * FULL cell state, and an omitted `revenuePercent` RESETS the stored one to 0 (pinned by an API
 * test). So a per-field write would turn "correct the rate" into "silently stop paying revenue
 * share": a pay cut with nothing on screen to show it happened. Committing on cell exit means
 * both current values are always in hand, and it also matches how the figures are entered —
 * rate then percent, tab, next cell.
 */
function PayCell({
  level,
  location,
  rate,
}: {
  level: Level;
  location: Location;
  rate: PayRateDto | undefined;
}) {
  const set = useSetPayRate();
  const clear = useClearPayRate();
  const stored = displayed(rate);
  const [rateText, setRateText] = useState(stored.rate);
  const [percentText, setPercentText] = useState(stored.percent);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  /**
   * Whether the last write of THIS cell succeeded.
   *
   * Needed because committing on cell-exit means a successful save changes nothing on screen: the
   * text stays whatever was typed either way. Every other write path in the app moves something
   * (a row leaves edit mode, a schedule cell fills in), and a failure here already announces
   * itself — so silent success would be the one outcome an admin could not tell from having done
   * nothing. Cleared on the next keystroke, so it can never describe a figure that has since
   * changed.
   */
  const [saved, setSaved] = useState(false);

  const dirty = rateText !== stored.rate || percentText !== stored.percent;

  /** Put the stored figures back, so nothing abandoned stays on screen looking saved. */
  function revert() {
    setRateText(stored.rate);
    setPercentText(stored.percent);
    setError(null);
    setConfirmingClear(false);
    setSaved(false);
  }

  /** A keystroke in either box: the previous outcome no longer describes what is on screen. */
  function edited() {
    setSaved(false);
    setError(null);
  }

  async function commit() {
    if (!dirty) return; // Tabbing across the matrix to read it must not rewrite it.
    setError(null);

    const parsedRate = parseRate(rateText);
    const parsedPercent = parsePercent(percentText);

    // Both boxes emptied on a configured cell means "remove this cell" — a payroll-blocking
    // change, so it is confirmed rather than done. On an unconfigured cell it means nothing.
    if (parsedRate === blank && parsedPercent === blank) {
      if (rate) setConfirmingClear(true);
      else revert();
      return;
    }

    if (parsedPercent === null) {
      setError(t.payMatrix.percentInvalid);
      return;
    }
    /*
     * A blank rate is refused rather than sent as 0.
     *
     * `0` is a legitimate day rate — a level paid purely on revenue share — so it has to be
     * TYPED. Inferring it from an empty box would let a mis-tab configure someone's guaranteed
     * daily pay as nothing, and the cell would then look correctly configured.
     */
    if (parsedRate === null || parsedRate === blank) {
      setError(t.payMatrix.rateInvalid);
      return;
    }

    try {
      // Always BOTH values: the body is the whole cell, and an omitted percent means 0.
      await set.mutateAsync({
        levelId: level.id,
        locationId: location.id,
        ratePerDay: parsedRate,
        // A blank percent alongside a real rate is an explicit "no revenue share".
        revenuePercent: parsedPercent === blank ? 0 : parsedPercent,
      });
      setSaved(true);
    } catch (err) {
      // The typed figures stay on screen with the reason beside them: discarding an admin's
      // entry on a failed write makes the failure look like a successful no-op.
      setError((err as Error).message);
    }
  }

  async function doClear() {
    setError(null);
    try {
      await clear.mutateAsync({ levelId: level.id, locationId: location.id });
      setConfirmingClear(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = set.isPending || clear.isPending;

  return (
    <div
      className="matrix__cell"
      /*
       * One blur handler for the cell, not one per input.
       *
       * `relatedTarget` is where focus is going, so a move BETWEEN this cell's two inputs is not
       * a commit — which is what makes "rate, tab, percent, tab" write once with both figures
       * rather than twice, the second time with a percent the first write had already reset.
       */
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        void commit();
      }}
      onKeyDown={(e) => {
        // Enter commits from either field — the fastest path when correcting one figure.
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        }
        // Escape abandons the edit. Without it the only way out of a half-typed cell is to
        // retype the stored figures from memory.
        if (e.key === 'Escape') revert();
      }}
    >
      <span className="matrix__figure">
        <input
          className="matrix__input mono"
          type="text"
          inputMode="decimal"
          aria-label={t.payMatrix.rateFor(level.name, location.name)}
          aria-invalid={error ? true : undefined}
          disabled={busy}
          value={rateText}
          onChange={(e) => {
            setRateText(e.target.value);
            edited();
          }}
        />
        <span className="matrix__unit" aria-hidden="true">{t.payMatrix.rateUnit}</span>
      </span>

      <span className="matrix__figure">
        <input
          className="matrix__input mono"
          type="text"
          inputMode="decimal"
          aria-label={t.payMatrix.percentFor(level.name, location.name)}
          aria-invalid={error ? true : undefined}
          disabled={busy}
          value={percentText}
          onChange={(e) => {
            setPercentText(e.target.value);
            edited();
          }}
        />
        <span className="matrix__unit" aria-hidden="true">{t.payMatrix.percentUnit}</span>
      </span>

      {/* Word, not colour alone: the muted wash says "different", the word says what. */}
      {!rate && !dirty ? <p className="matrix__unsetNote">{t.payMatrix.notConfigured}</p> : null}

      {/*
        * Both outcomes are announced, not just drawn: focus has already left this cell by the
        * time either appears, so a keyboard or screen-reader user gets no cue otherwise. Polite
        * rather than assertive — this reports what happened, it does not interrupt.
        */}
      {error ? <p className="matrix__error" role="status">{error}</p> : null}
      {saved && !error ? <p className="matrix__saved" role="status">{t.payMatrix.saved}</p> : null}

      {confirmingClear ? (
        /*
         * Inline, not a modal. The confirmation has to keep the cell it is about visible — a
         * dialog covering the matrix would ask "remove the pay for this combination?" with the
         * combination itself hidden behind it.
         */
        <div className="matrix__confirm" role="group" aria-label={t.payMatrix.clearTitle}>
          <p className="matrix__confirmText">{t.payMatrix.clearConfirm}</p>
          <p className="matrix__confirmWhich mono">{t.payMatrix.clearFor(level.name, location.name)}</p>
          <span className="row-actions">
            <Button size="sm" variant="danger" onClick={() => void doClear()} disabled={busy}>
              {t.payMatrix.clear}
            </Button>
            <Button size="sm" variant="quiet" onClick={revert}>
              {t.common.cancel}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
