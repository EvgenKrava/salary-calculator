/**
 * Parsing the two figures that decide what a day of work is worth.
 *
 * Both conversions are here rather than in the component because getting either wrong is a
 * silent payroll error — the API accepts the wrong value happily and the UI shows back whatever
 * it sent, so there is no moment where a person sees that something is off.
 *
 * These moved out of `routes/EmployeesRoute.tsx`, where the revenue percent used to live on the
 * employee. It now lives on the (level, location) matrix, and the matrix's column is
 * `NUMERIC(6,5)` where the employee's was `NUMERIC(6,4)` — so the rounding below changed with
 * it. Rounding to the OLD scale would show a manager 1.23% for the 1.235% actually stored.
 */

/**
 * Blank means "no value here", which is a different fact from zero.
 *
 * A symbol rather than `null`, because `null` is already taken by "unusable input" and these two
 * outcomes lead somewhere different: blank on both fields of a configured cell means *remove the
 * cell*, while unusable means *refuse and say why*. Declared and exported in one statement so
 * TypeScript infers `unique symbol` — assigning it through a second `const` widens it to plain
 * `symbol`, and then `x === blank` stops narrowing the union at every call site.
 */
export const blank = Symbol('blank');
export type Blank = typeof blank;

/**
 * A human percentage (`3`, `12.5`) as the fraction the API stores (`0.03`, `0.125`).
 *
 * The 100x hazard: the wire format is a fraction in 0..1 and the UI speaks percentages. `3` sent
 * unconverted is refused by the API (max 1) — loudly, which is the safe direction — but `0.03`
 * typed by a manager who means 3% would quietly pay 0.03% of revenue.
 *
 * Returns `blank` for an empty field, `null` for anything unusable. Out-of-range is NOT clamped:
 * clamping `500` to 100% would pay one person the location's entire revenue.
 */
export function parsePercent(text: string): number | Blank | null {
  const trimmed = text.trim();
  if (trimmed === '') return blank;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  // 5 decimal places, matching pay_rates.revenue_percent NUMERIC(6,5). More precision than the
  // column holds would be silently discarded, and the UI would misreport what was saved.
  return Math.round((value / 100) * 100_000) / 100_000;
}

/** The stored fraction back as the percentage a human typed: `0.03` -> `"3"`. */
export function formatPercent(fraction: number): string {
  return String(Math.round(fraction * 100 * 100_000) / 100_000);
}

/**
 * A day rate as entered.
 *
 * `blank` for empty, `null` for unusable or negative. Zero is VALID and deliberate: a level paid
 * purely on revenue share at some location is a real configuration. That is exactly why blank
 * cannot be treated as zero — the difference between "paid nothing per day" and "not configured
 * at all" is the difference between a run that pays and a run that is blocked.
 */
export function parseRate(text: string): number | Blank | null {
  const trimmed = text.trim();
  if (trimmed === '') return blank;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  // 2 decimal places, matching pay_rates.rate_per_day NUMERIC(10,2).
  return Math.round(value * 100) / 100;
}
