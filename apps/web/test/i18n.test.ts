import { describe, it, expect } from 'vitest';
import { formatDate, formatTimestampDate, hoursLabel, plural, shiftsLabel, t, MONTHS } from '../src/lib/i18n';

/**
 * Ukrainian localisation: the two things that are genuinely easy to get wrong.
 *
 * Everything else in i18n.ts is a string table, which a test can only restate. Plural
 * selection and date parsing carry real logic, so they are pinned here.
 */

describe('plural', () => {
  it('matches Intl.PluralRules for uk-UA across 0-200', () => {
    // Ukrainian has THREE forms, not two: 1 день / 2 дні / 5 днів. An `n === 1 ? a : b` check
    // would be wrong for most numbers, so this asserts against ICU rather than a hand-written
    // list of cases.
    const pr = new Intl.PluralRules('uk-UA');
    const expected: Record<string, string> = { one: 'ONE', few: 'FEW', many: 'MANY', other: 'MANY' };
    for (let n = 0; n <= 200; n++) {
      expect(plural(n, 'ONE', 'FEW', 'MANY'), `n=${n}`).toBe(expected[pr.select(n)]);
    }
  });

  it('handles the teens exception, where the naive mod-10 rule breaks', () => {
    // 11 and 21 both end in 1, but 11 takes the MANY form.
    expect(plural(1, 'a', 'b', 'c')).toBe('a');
    expect(plural(11, 'a', 'b', 'c')).toBe('c');
    expect(plural(21, 'a', 'b', 'c')).toBe('a');
    // 12-14 take MANY even though they end in 2-4.
    expect(plural(2, 'a', 'b', 'c')).toBe('b');
    expect(plural(12, 'a', 'b', 'c')).toBe('c');
    expect(plural(22, 'a', 'b', 'c')).toBe('b');
  });

  it('treats 0 as the many form, as Ukrainian requires', () => {
    expect(plural(0, 'година', 'години', 'годин')).toBe('годин');
  });

  it('ignores sign and fraction rather than throwing', () => {
    expect(plural(-1, 'a', 'b', 'c')).toBe('a');
    expect(plural(2.7, 'a', 'b', 'c')).toBe('b');
  });

  it('builds readable hour and shift labels', () => {
    expect(hoursLabel(1)).toBe('1 година');
    expect(hoursLabel(3)).toBe('3 години');
    expect(hoursLabel(8)).toBe('8 годин');
    expect(shiftsLabel(1)).toBe('1 зміна');
    expect(shiftsLabel(2)).toBe('2 зміни');
    expect(shiftsLabel(5)).toBe('5 змін');
  });
});

describe('formatDate', () => {
  it('renders an ISO date in the Ukrainian convention', () => {
    expect(formatDate('2026-05-05')).toBe('05.05.2026');
    expect(formatDate('2026-12-31')).toBe('31.12.2026');
  });

  it('does not shift the day, regardless of the machine timezone', () => {
    // The bug this guards: `new Date('2026-05-01')` is parsed as UTC midnight and rendered in
    // local time, so in any negative-offset timezone it displays 30.04 — moving a pay-period
    // boundary by a day. formatDate splits the string instead of constructing a Date.
    expect(formatDate('2026-05-01')).toBe('01.05.2026');
    expect(formatDate('2026-01-01')).toBe('01.01.2026');
    // Period boundaries specifically: 1st, 15th, 16th, and month end.
    expect(formatDate('2026-06-15')).toBe('15.06.2026');
    expect(formatDate('2026-06-16')).toBe('16.06.2026');
  });

  it('tolerates a full timestamp by using only the date part', () => {
    expect(formatDate('2026-05-05T21:30:00.000Z')).toBe('05.05.2026');
  });

  it('returns the input unchanged rather than throwing on an unexpected shape', () => {
    // A malformed value should show the raw string a manager can report, not "NaN.NaN.NaN".
    expect(formatDate('')).toBe('');
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatTimestampDate', () => {
  it('converts a UTC timestamp to the local Kyiv date', () => {
    // The bug: created_at is a timestamptz, so slicing its first 10 characters (or passing it
    // to formatDate, which does the same) shows the UTC date. A run created at 22:30 UTC on the
    // 5th was already the 6th in Kyiv, and the "Past runs" table would date it a day early.
    expect(formatTimestampDate('2026-08-05T22:30:00.000Z')).toBe('06.08.2026');
    expect(formatDate('2026-08-05T22:30:00.000Z')).toBe('05.08.2026'); // wrong for a timestamp
  });

  it('keeps the same date when the instant is mid-day', () => {
    expect(formatTimestampDate('2026-08-05T09:00:00.000Z')).toBe('05.08.2026');
  });

  it('crosses the year boundary correctly', () => {
    // 31 Dec 22:00 UTC is already 1 Jan in Kyiv.
    expect(formatTimestampDate('2026-12-31T22:00:00.000Z')).toBe('01.01.2027');
  });

  it('handles both Kyiv offsets, so DST does not shift the date', () => {
    // Kyiv is UTC+2 in winter and UTC+3 in summer; 22:30 crosses midnight in summer only.
    expect(formatTimestampDate('2026-01-15T22:30:00.000Z')).toBe('16.01.2026');
    expect(formatTimestampDate('2026-07-15T21:30:00.000Z')).toBe('16.07.2026');
  });

  it('returns the input rather than "Invalid Date" on junk', () => {
    expect(formatTimestampDate('not-a-timestamp')).toBe('not-a-timestamp');
  });

  it('is independent of the machine timezone', () => {
    // Explicit timeZone means CI in UTC and a laptop in Kyiv agree.
    expect(formatTimestampDate('2026-08-05T22:30:00.000Z', 'Europe/Kyiv')).toBe('06.08.2026');
    expect(formatTimestampDate('2026-08-05T22:30:00.000Z', 'UTC')).toBe('05.08.2026');
  });
});

describe('string table', () => {
  it('has no English left in the visible copy', () => {
    // Catches a key added during translation but left in English. Allows Latin only where it
    // is a proper noun or technical identifier a Ukrainian user would also see in Latin.
    const ALLOWED = /Cognito|sub|xlsx|₴/;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        if (/[A-Za-z]{4,}/.test(node) && !ALLOWED.test(node)) offenders.push(`${path}: ${node}`);
        return;
      }
      if (typeof node === 'function') return; // interpolating helpers are checked by use
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      }
    };
    walk(t, 't');
    expect(offenders).toEqual([]);
  });

  it('names all twelve months', () => {
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[0]).toBe('Січень');
    expect(MONTHS[11]).toBe('Грудень');
    // Every entry must be Cyrillic — a missed month would show as English in the picker.
    for (const m of MONTHS) expect(m).toMatch(/^[А-ЯЇІЄҐ][а-яїієґ]+$/);
  });

  it('interpolates names into parameterised strings', () => {
    expect(t.runs.bonusFor('Олена')).toContain('Олена');
    expect(t.common.couldNotLoad('зміни')).toContain('зміни');
  });
});
