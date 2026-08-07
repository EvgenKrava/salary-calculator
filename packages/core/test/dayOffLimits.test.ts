import { describe, it, expect } from 'vitest';
import { canAdd, classifyConflicts, countInMonth, findOverlaps } from '../src/dayOffLimits';

const LIMITS = { required: 2, preferred: 4 };

describe('countInMonth', () => {
  it('counts each kind within the given month only', () => {
    const requests = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-20', kind: 'preferred' as const },
      { requestDate: '2026-10-01', kind: 'required' as const }, // different month
    ];
    expect(countInMonth(requests, 2026, 9)).toEqual({ required: 1, preferred: 1 });
  });

  it('does not confuse the same month in different years', () => {
    const requests = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2027-09-01', kind: 'required' as const },
    ];
    expect(countInMonth(requests, 2027, 9)).toEqual({ required: 1, preferred: 0 });
  });

  it('returns zeroes for a month with nothing in it', () => {
    expect(countInMonth([], 2026, 9)).toEqual({ required: 0, preferred: 0 });
  });
});

describe('canAdd', () => {
  it('allows a request under the limit', () => {
    expect(canAdd([], '2026-09-05', 'required', LIMITS)).toEqual({ ok: true });
  });

  it('refuses one past the limit, naming which limit and its value', () => {
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-09-03', 'required', LIMITS)).toEqual({
      ok: false,
      reason: 'limit_reached',
      kind: 'required',
      limit: 2,
    });
  });

  it('counts the two kinds separately', () => {
    // Required is full; preferred still has room.
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-09-03', 'preferred', LIMITS)).toEqual({ ok: true });
  });

  it('scopes the limit to the month of the date being added', () => {
    // September is full, October is empty — an October request must be allowed.
    const existing = [
      { requestDate: '2026-09-01', kind: 'required' as const },
      { requestDate: '2026-09-02', kind: 'required' as const },
    ];
    expect(canAdd(existing, '2026-10-01', 'required', LIMITS)).toEqual({ ok: true });
  });

  it('treats a zero limit as "none allowed" rather than unlimited', () => {
    expect(canAdd([], '2026-09-01', 'required', { required: 0, preferred: 4 })).toEqual({
      ok: false,
      reason: 'limit_reached',
      kind: 'required',
      limit: 0,
    });
  });
});

describe('classifyConflicts', () => {
  it('splits shifts by the kind of day-off they land on', () => {
    const shifts = [
      { employeeId: 'e1', workDate: '2026-09-05' }, // required
      { employeeId: 'e1', workDate: '2026-09-06' }, // preferred
      { employeeId: 'e1', workDate: '2026-09-07' }, // no request
      { employeeId: 'e2', workDate: '2026-09-05' }, // e2 has no requests at all
    ];
    const byEmployee = new Map([
      [
        'e1',
        [
          { requestDate: '2026-09-05', kind: 'required' as const },
          { requestDate: '2026-09-06', kind: 'preferred' as const },
        ],
      ],
    ]);
    const out = classifyConflicts(shifts, byEmployee);
    expect(out.required).toEqual([{ employeeId: 'e1', workDate: '2026-09-05' }]);
    expect(out.preferred).toEqual([{ employeeId: 'e1', workDate: '2026-09-06' }]);
  });

  it('reports nothing when no shift lands on a requested day', () => {
    const out = classifyConflicts([{ employeeId: 'e1', workDate: '2026-09-09' }], new Map());
    expect(out).toEqual({ required: [], preferred: [] });
  });
});

describe('findOverlaps', () => {
  /*
   * The rule that stops double pay. Two approved shifts for one person in overlapping hours means
   * the same hours are paid twice: measured on a 600.00/day level, one 6-hour shift priced 300.00
   * and a duplicated pair priced 600.00.
   */
  const shift = (employeeId: string, workDate: string, startsAt: string, endsAt: string) => ({
    employeeId,
    workDate,
    startsAt,
    endsAt,
  });

  it('finds two shifts for one person in the same window', () => {
    const out = findOverlaps([shift('e1', '2026-09-07', '08:00', '14:00')], [
      shift('e1', '2026-09-07', '08:00', '14:00'),
    ]);
    expect(out).toEqual([{ employeeId: 'e1', workDate: '2026-09-07' }]);
  });

  it('finds a partial overlap, which no unique constraint catches', () => {
    const out = findOverlaps([shift('e1', '2026-09-08', '13:00', '18:00')], [
      shift('e1', '2026-09-08', '08:00', '14:00'),
    ]);
    expect(out).toEqual([{ employeeId: 'e1', workDate: '2026-09-08' }]);
  });

  it('finds an overlap between two candidates, not just against existing shifts', () => {
    const out = findOverlaps(
      [shift('e1', '2026-09-07', '08:00', '14:00'), shift('e1', '2026-09-07', '10:00', '16:00')],
      [],
    );
    expect(out).toEqual([{ employeeId: 'e1', workDate: '2026-09-07' }]);
  });

  it('allows back-to-back windows that only touch', () => {
    // Half-open comparison: 08:00-14:00 and 14:00-20:00 are a split day, not a clash.
    const out = findOverlaps(
      [shift('e1', '2026-09-09', '08:00', '14:00'), shift('e1', '2026-09-09', '14:00', '20:00')],
      [],
    );
    expect(out).toEqual([]);
  });

  it('does not confuse two different people, or one person on two days', () => {
    const out = findOverlaps(
      [shift('e1', '2026-09-09', '08:00', '14:00'), shift('e2', '2026-09-09', '08:00', '14:00')],
      [shift('e1', '2026-09-10', '08:00', '14:00')],
    );
    expect(out).toEqual([]);
  });

  it('reports one entry per employee-day however many shifts collide', () => {
    // The manager needs to know which day to fix, not how many rows are involved.
    const out = findOverlaps(
      [
        shift('e1', '2026-09-07', '08:00', '14:00'),
        shift('e1', '2026-09-07', '09:00', '15:00'),
        shift('e1', '2026-09-07', '10:00', '16:00'),
      ],
      [],
    );
    expect(out).toEqual([{ employeeId: 'e1', workDate: '2026-09-07' }]);
  });

  it('tolerates HH:MM:SS, which is what the TIME column returns', () => {
    const out = findOverlaps([shift('e1', '2026-09-07', '08:00:00', '14:00:00')], [
      shift('e1', '2026-09-07', '13:00:00', '18:00:00'),
    ]);
    expect(out).toEqual([{ employeeId: 'e1', workDate: '2026-09-07' }]);
  });
});
