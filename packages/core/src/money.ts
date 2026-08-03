/** Round a monetary amount to 2 decimal places (cents). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}