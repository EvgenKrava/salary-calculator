import { describe, it, expect } from 'vitest';
import { payPeriodsForMonth, isWithinPeriod } from '../src/payPeriod';

describe('payPeriodsForMonth', () => {
  it('splits a 31-day month into 1-15 and 16-31', () => {
    const [first, second] = payPeriodsForMonth(2026, 8);
    expect(first).toEqual({ start: '2026-08-01', end: '2026-08-15' });
    expect(second).toEqual({ start: '2026-08-16', end: '2026-08-31' });
  });

  it('handles February in a non-leap year', () => {
    const [, second] = payPeriodsForMonth(2026, 2);
    expect(second).toEqual({ start: '2026-02-16', end: '2026-02-28' });
  });

  it('handles February in a leap year', () => {
    const [, second] = payPeriodsForMonth(2024, 2);
    expect(second).toEqual({ start: '2024-02-16', end: '2024-02-29' });
  });
});

describe('isWithinPeriod', () => {
  const period = { start: '2026-08-01', end: '2026-08-15' };

  it('includes both boundaries', () => {
    expect(isWithinPeriod('2026-08-01', period)).toBe(true);
    expect(isWithinPeriod('2026-08-15', period)).toBe(true);
  });

  it('excludes dates outside the range', () => {
    expect(isWithinPeriod('2026-08-16', period)).toBe(false);
    expect(isWithinPeriod('2026-07-31', period)).toBe(false);
  });
});