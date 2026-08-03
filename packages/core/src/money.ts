/**
 * Round a monetary amount to 2 decimal places (cents), half away from zero.
 *
 * A naive `Math.round(value * 100) / 100` mis-rounds half-cent boundaries
 * (e.g. 1.005 -> 1.00) because values like 1.005 are stored slightly below
 * their decimal value in binary floating point. Correcting the scaled value
 * proportionally to its magnitude (`* (1 + Number.EPSILON)`) absorbs that
 * representation drift without over-rounding amounts genuinely below the
 * boundary, since the correction is far smaller than any real fractional gap.
 */
export function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 100;
  const rounded = Math.round(scaled * (1 + Number.EPSILON));
  return (sign * rounded) / 100;
}