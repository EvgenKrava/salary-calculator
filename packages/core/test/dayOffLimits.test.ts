import { describe, it, expect } from 'vitest';
import { canAdd, classifyConflicts, countInMonth } from '../src/dayOffLimits';

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
