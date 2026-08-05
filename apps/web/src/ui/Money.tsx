import './money.css';

/**
 * The one component every money figure goes through — the signature element of the design
 * system.
 *
 * Rules it enforces so callers cannot get them wrong:
 * - exactly 2 decimals, never abbreviated ("12.5k" is unacceptable in a pay breakdown)
 * - zero renders as "0.00"; only genuinely-unknown renders blank, because in payroll those
 *   are different facts and a dash would conflate them
 * - mono + tabular figures + right-aligned, so a column of figures aligns digit-for-digit
 */
export function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="money money--unknown" aria-label="unknown" />;
  }
  return <span className="money mono">{value.toFixed(2)}</span>;
}
