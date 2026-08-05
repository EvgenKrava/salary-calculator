import { describe, expect, it } from 'vitest';
import { toSqlTime } from '../src/time';

/**
 * `HH:MM` -> `HH:MM:SS` for Postgres TIME columns.
 *
 * The bug this exists for: the RDS Data API rejects `'09:00'` for a TIME column with
 * `Parse Error for Time: premature end of input`, while PGlite — what every other test uses —
 * accepts it. So creating a location, shift slot, or shift passed the whole suite and returned
 * an opaque 500 against the real database. No unit test could have caught it; only this
 * normalisation being applied at every write site prevents it.
 */
describe('toSqlTime', () => {
  it('widens HH:MM to HH:MM:SS', () => {
    expect(toSqlTime('09:00')).toBe('09:00:00');
    expect(toSqlTime('00:00')).toBe('00:00:00');
    expect(toSqlTime('23:59')).toBe('23:59:00');
  });

  it('is idempotent, so applying it twice is safe', () => {
    expect(toSqlTime('09:00:00')).toBe('09:00:00');
    expect(toSqlTime(toSqlTime('21:30'))).toBe('21:30:00');
  });

  it('preserves a non-zero seconds component rather than truncating it', () => {
    expect(toSqlTime('09:00:30')).toBe('09:00:30');
  });

  it('throws on a non-time rather than letting the database 500', () => {
    // A rejected value names the field; an accepted one becomes an opaque
    // "DatabaseErrorException" in CloudWatch with no indication of which input was wrong.
    for (const bad of ['', '9:00', '09', '24:00', '23:60', 'abc', '09:00:00:00']) {
      expect(() => toSqlTime(bad), bad).toThrow(/invalid time/);
    }
  });

  it('rejects 24:00, which Postgres TIME accepts but the API contract does not', () => {
    // Migration 0002 forbids 24:00:00 in the DB precisely because the API slices times back to
    // HH:MM and could not round-trip it.
    expect(() => toSqlTime('24:00')).toThrow();
  });
});
