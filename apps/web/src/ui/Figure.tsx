import type { ReactNode } from 'react';
import './figure.css';

/**
 * The period total at the top of a ledger screen, set in display-size mono.
 *
 * This is the second signature element after the money column, and the rules in
 * docs/design/system.md § Display numerals are what keep it from becoming decoration:
 * **one per screen**, and only for a figure the user actually came for — a period total, a run
 * total. Never a row count, never a percentage. Two competing display figures on one screen
 * means neither is the answer.
 *
 * `value` is a pre-formatted string rather than a number because callers already own their
 * formatting (Money enforces 2 decimals, a count is an integer, an hours figure is neither) and
 * a second formatter here would be a second place for the rules to drift.
 */
export function Figure({
  value,
  unit,
  label,
  tone = 'money',
  children,
}: {
  /** Pre-formatted. Callers use Money's rules for currency. */
  value: ReactNode;
  /** Currency or unit, set small beside the figure. */
  unit?: ReactNode;
  /** What period or scope this covers — "за серпень 2026". */
  label?: ReactNode;
  /** `plain` for a non-monetary total, so amber stays tied to money. */
  tone?: 'money' | 'plain';
  /** Optional trailing content — a sparkline, a status pill. */
  children?: ReactNode;
}) {
  return (
    <div className="figure">
      <div className="figure__row">
        <span className={`figure__value figure__value--${tone} mono`}>{value}</span>
        {unit ? <span className="figure__unit">{unit}</span> : null}
      </div>
      {label ? <p className="figure__label">{label}</p> : null}
      {children}
    </div>
  );
}
