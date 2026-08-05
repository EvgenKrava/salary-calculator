import { describe, it, expect } from 'vitest';
import { percentToFraction, fractionToPercent } from '../src/routes/EmployeesRoute';
import { shiftHours } from '../src/lib/hours';

/**
 * Revenue percent is entered as a human percent (5) and stored as a fraction (0.05).
 *
 * Getting this conversion wrong is a 100x payroll error in either direction, and the API
 * accepts anything in 0–1 — so `5` sent unconverted would be rejected, but `0.05` typed by a
 * manager expecting "5%" would silently pay 0.05% of revenue. Round-tripping is asserted
 * because the UI shows back what it saved.
 */
describe('revenue percent conversion', () => {
  it('converts a human percent to the stored fraction', () => {
    expect(percentToFraction('5')).toBe(0.05);
    expect(percentToFraction('12.5')).toBe(0.125);
    expect(percentToFraction('100')).toBe(1);
    expect(percentToFraction('0')).toBe(0);
  });

  it('treats blank as zero rather than invalid', () => {
    expect(percentToFraction('')).toBe(0);
    expect(percentToFraction('   ')).toBe(0);
  });

  it('rejects out-of-range and non-numeric input instead of clamping it', () => {
    // Clamping 500 to 100% would pay someone the entire location's revenue.
    expect(percentToFraction('101')).toBeNull();
    expect(percentToFraction('500')).toBeNull();
    expect(percentToFraction('-1')).toBeNull();
    expect(percentToFraction('abc')).toBeNull();
  });

  it('rounds to the 4 decimal places the NUMERIC(6,4) column stores', () => {
    // Without rounding, the UI would display a precision the database silently discarded.
    expect(percentToFraction('1.23456')).toBe(0.0123);
  });

  it('round-trips a stored fraction back to the displayed percent', () => {
    expect(fractionToPercent(0.05)).toBe('5');
    expect(fractionToPercent(0.125)).toBe('12.5');
    expect(fractionToPercent(0)).toBe('0');
    expect(fractionToPercent(1)).toBe('100');
  });

  it('survives a percent -> fraction -> percent round trip', () => {
    for (const p of ['0', '5', '12.5', '33.33', '100']) {
      expect(fractionToPercent(percentToFraction(p)!)).toBe(p);
    }
  });
});

describe('shiftHours', () => {
  it('matches the core hoursBetween semantics for whole-hour and part-hour windows', () => {
    expect(shiftHours('08:00', '16:00')).toBe('8.00');
    expect(shiftHours('08:30', '12:00')).toBe('3.50');
    expect(shiftHours('09:15', '09:30')).toBe('0.25');
  });

  it('formats to two decimals so a partial hour is never shown as a whole one', () => {
    expect(shiftHours('08:00', '08:20')).toBe('0.33');
  });
});
