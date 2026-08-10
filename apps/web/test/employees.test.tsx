import { describe, it, expect } from 'vitest';
import { parsePercent, formatPercent, parseRate, blank } from '../src/lib/pay';
import { shiftHours } from '../src/lib/hours';

/**
 * Revenue percent is entered as a human percent (5) and stored as a fraction (0.05).
 *
 * Getting this conversion wrong is a 100x payroll error in either direction, and the API
 * accepts anything in 0–1 — so `5` sent unconverted would be rejected, but `0.05` typed by a
 * manager expecting "5%" would silently pay 0.05% of revenue. Round-tripping is asserted
 * because the UI shows back what it saved.
 *
 * These conversions used to live on EmployeesRoute, where the percent was an employee field.
 * It now belongs to a (level, location) matrix cell, so they moved to `lib/pay.ts` — and the
 * rounding scale moved with them, because the matrix column is NUMERIC(6,5) where the
 * employee's was NUMERIC(6,4).
 */
describe('revenue percent conversion', () => {
  it('converts a human percent to the stored fraction', () => {
    expect(parsePercent('5')).toBe(0.05);
    expect(parsePercent('12.5')).toBe(0.125);
    expect(parsePercent('100')).toBe(1);
    expect(parsePercent('0')).toBe(0);
  });

  it('reports blank as blank, not as zero', () => {
    /*
     * The distinction the matrix is built on. A cell with 0% is configured and pays; a cell with
     * nothing in it is NOT configured and blocks the run. Collapsing the two would make an
     * unconfigured cell look like a deliberate 0 and silently unblock a payroll run that should
     * have stopped.
     */
    expect(parsePercent('')).toBe(blank);
    expect(parsePercent('   ')).toBe(blank);
  });

  it('rejects out-of-range and non-numeric input instead of clamping it', () => {
    // Clamping 500 to 100% would pay someone the entire location's revenue.
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('500')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
  });

  it('rounds to the 5 decimal places the NUMERIC(6,5) column stores', () => {
    // Without rounding, the UI would display a precision the database silently discarded.
    // At the OLD (6,4) scale this would be 0.0123 — i.e. this pins the scale, not just that
    // rounding happens at all.
    expect(parsePercent('1.23456')).toBe(0.01235);
  });

  it('round-trips a stored fraction back to the displayed percent', () => {
    expect(formatPercent(0.05)).toBe('5');
    expect(formatPercent(0.125)).toBe('12.5');
    expect(formatPercent(0)).toBe('0');
    expect(formatPercent(1)).toBe('100');
  });

  it('survives a percent -> fraction -> percent round trip', () => {
    for (const p of ['0', '5', '12.5', '33.33', '100']) {
      expect(formatPercent(parsePercent(p) as number)).toBe(p);
    }
  });
});

/**
 * The day rate. Zero is a real, payable configuration (a level paid purely on revenue share at
 * some location), which is exactly why blank cannot be read as zero.
 */
describe('day rate parsing', () => {
  it('accepts a rate as entered, rounded to the stored 2 decimals', () => {
    expect(parseRate('600')).toBe(600);
    expect(parseRate('600.50')).toBe(600.5);
    expect(parseRate('600.567')).toBe(600.57);
  });

  it('accepts an explicit zero, which is a deliberate configuration', () => {
    expect(parseRate('0')).toBe(0);
  });

  it('reports blank as blank rather than as a zero rate', () => {
    // A blank rate saved as 0 would silently stop paying for the day itself while looking
    // configured — and it would unblock a run that should have been refused.
    expect(parseRate('')).toBe(blank);
    expect(parseRate('  ')).toBe(blank);
  });

  it('refuses a negative or non-numeric rate', () => {
    expect(parseRate('-1')).toBeNull();
    expect(parseRate('abc')).toBeNull();
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
