import { describe, it, expect } from 'vitest';
import { parseTime, hoursBetween, isTimeString } from '../src/time';

describe('parseTime', () => {
  it('converts HH:MM to minutes since midnight', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('08:30')).toBe(510);
    expect(parseTime('23:59')).toBe(1439);
  });

  it('throws on malformed input', () => {
    expect(() => parseTime('8:30')).toThrow();
    expect(() => parseTime('24:00')).toThrow();
    expect(() => parseTime('08:60')).toThrow();
    expect(() => parseTime('not a time')).toThrow();
  });
});

describe('hoursBetween', () => {
  it('returns decimal hours', () => {
    expect(hoursBetween('08:00', '16:00')).toBe(8);
    expect(hoursBetween('08:00', '12:30')).toBe(4.5);
    expect(hoursBetween('09:15', '09:45')).toBe(0.5);
  });

  it('throws when the end is not after the start', () => {
    expect(() => hoursBetween('08:00', '08:00')).toThrow();
    expect(() => hoursBetween('16:00', '08:00')).toThrow();
  });
});

describe('isTimeString', () => {
  it('accepts valid and rejects invalid times', () => {
    expect(isTimeString('07:05')).toBe(true);
    expect(isTimeString('7:05')).toBe(false);
    expect(isTimeString('25:00')).toBe(false);
  });
});
