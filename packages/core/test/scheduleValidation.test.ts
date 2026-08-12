import { describe, it, expect } from 'vitest';
import {
  validateAssignments,
  type ProposedAssignment,
  type ValidationContext,
} from '../src/scheduleValidation';

/** A generous period with staffing covering every weekday, so tests can focus on the one rule
 *  under test without also hand-computing which weekday a date falls on. */
function baseCtx(): ValidationContext {
  return {
    period: { start: '2026-09-01', end: '2026-09-15' },
    employees: [{ id: 'e1', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] }],
    locations: [
      {
        id: 'locA',
        slots: [
          { slotNumber: 1, startsAt: '08:00', endsAt: '16:00' },
          { slotNumber: 2, startsAt: '16:00', endsAt: '22:00' },
        ],
      },
    ],
    staffing: Array.from({ length: 7 }, (_, weekday) => ({ locationId: 'locA', weekday, peopleNeeded: 1 })),
    requiredDaysOff: [],
    preferredDaysOff: [],
    approvedShifts: [],
  };
}

function assignment(overrides: Partial<ProposedAssignment> = {}): ProposedAssignment {
  return { employeeId: 'e1', locationId: 'locA', date: '2026-09-01', slotNumber: 1, ...overrides };
}

describe('validateAssignments', () => {
  it('accepts a clean assignment with no flags', () => {
    const result = validateAssignments([assignment()], baseCtx());
    expect(result.accepted).toEqual([assignment()]);
    expect(result.rejected).toEqual([]);
    expect(result.flags).toEqual([]);
  });

  it('accepts multiple independent assignments for different employees', () => {
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    const a1 = assignment({ employeeId: 'e1', slotNumber: 1 });
    const a2 = assignment({ employeeId: 'e2', slotNumber: 2 });
    const result = validateAssignments([a1, a2], ctx);
    expect(result.accepted).toEqual([a1, a2]);
    expect(result.rejected).toEqual([]);
  });

  it('returns empty results for an empty proposal list', () => {
    expect(validateAssignments([], baseCtx())).toEqual({ accepted: [], rejected: [], flags: [] });
  });
});

describe('unknown_employee', () => {
  it('rejects an assignment for an employee not in the context', () => {
    const a = assignment({ employeeId: 'ghost' });
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'unknown_employee' }]);
  });
});

describe('inactive_employee', () => {
  it('rejects an assignment for an employee marked inactive', () => {
    const ctx = baseCtx();
    ctx.employees[0].active = false;
    const a = assignment();
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'inactive_employee' }]);
  });

  it('reports inactive_employee ahead of unknown_location when both are true (determinism)', () => {
    const ctx = baseCtx();
    ctx.employees[0].active = false;
    const a = assignment({ locationId: 'ghost-location' });
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'inactive_employee' }]);
  });
});

describe('unknown_location', () => {
  it('rejects an assignment for a location not in the context', () => {
    const a = assignment({ locationId: 'ghost-location' });
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'unknown_location' }]);
  });
});

describe('unknown_slot', () => {
  it('rejects a slotNumber the location does not define', () => {
    const a = assignment({ slotNumber: 99 });
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'unknown_slot' }]);
  });

  it('reports unknown_slot ahead of outside_period when both are true (determinism)', () => {
    const a = assignment({ slotNumber: 99, date: '2026-10-01' }); // also outside the period
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'unknown_slot' }]);
  });
});

describe('outside_period', () => {
  it('rejects a date before the period start', () => {
    const a = assignment({ date: '2026-08-31' });
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'outside_period' }]);
  });

  it('rejects a date after the period end', () => {
    const a = assignment({ date: '2026-09-16' });
    const result = validateAssignments([a], baseCtx());
    expect(result.rejected).toEqual([{ assignment: a, reason: 'outside_period' }]);
  });

  it('accepts the period boundary dates themselves', () => {
    const start = assignment({ date: '2026-09-01' });
    const end = assignment({ date: '2026-09-15' });
    const result = validateAssignments([start, end], baseCtx());
    expect(result.rejected).toEqual([]);
  });
});

describe('required_day_off', () => {
  it('rejects an assignment landing on a required day off', () => {
    const ctx = baseCtx();
    ctx.requiredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' });
    const a = assignment();
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'required_day_off' }]);
  });

  it('reports required_day_off ahead of consecutive_limit when both are true (determinism)', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 2;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-30', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-31', startsAt: '08:00', endsAt: '16:00' },
    );
    // 2026-09-01 would extend the run to 3 (over the limit of 2) AND is a required day off.
    ctx.requiredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' });
    const a = assignment({ date: '2026-09-01' });
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'required_day_off' }]);
  });
});

describe('consecutive_limit', () => {
  it('rejects an assignment that would extend a run past maxConsecutiveDays', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 2;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-31', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-02' }); // would make a run of 3
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'consecutive_limit' }]);
  });

  it('accepts a run of exactly maxConsecutiveDays (boundary)', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 3;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-31', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-02' }); // run of exactly 3
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([]);
  });

  it('counts approved shifts from BEFORE the period start into the run (boundary run-in)', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 3;
    // Both approved dates are before period.start (2026-09-01) — the run-in the spec requires.
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-30', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-31', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-01' }); // extends the pre-period run to 3 (boundary, OK)
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([]);

    const b = assignment({ date: '2026-09-02' }); // would extend it to 4
    const secondResult = validateAssignments([a, b], ctx);
    expect(secondResult.rejected).toEqual([{ assignment: b, reason: 'consecutive_limit' }]);
  });

  it('counts already-accepted proposals within the same batch toward the run', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 2;
    const a = assignment({ date: '2026-09-01' });
    const b = assignment({ date: '2026-09-02' });
    const c = assignment({ date: '2026-09-03' }); // third consecutive day, over the limit of 2
    const result = validateAssignments([a, b, c], ctx);
    expect(result.accepted).toEqual([a, b]);
    expect(result.rejected).toEqual([{ assignment: c, reason: 'consecutive_limit' }]);
  });

  it('rejects the day that extends the run past the limit regardless of the array order given (order-independence)', () => {
    // Same three proposals as the "already-accepted proposals" case above, but handed to the
    // validator in reverse-chronological order — the way an LLM might emit them. Acceptance must
    // not depend on that order: chronologically 09-01 and 09-02 form the allowed run of 2, and
    // 09-03 is what extends it past the limit, however the caller ordered the array.
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 2;
    const a = assignment({ date: '2026-09-01' });
    const b = assignment({ date: '2026-09-02' });
    const c = assignment({ date: '2026-09-03' });
    const result = validateAssignments([c, b, a], ctx);
    expect(result.rejected).toEqual([{ assignment: c, reason: 'consecutive_limit' }]);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted).toContainEqual(a);
    expect(result.accepted).toContainEqual(b);
  });

  it('rejects a single proposal that bridges into an approved run starting the day after it', () => {
    // maxConsecutiveDays=2, approved shifts on 09-02 and 09-03. Proposing 09-01 alone forms a run
    // of three (09-01, 09-02, 09-03) even though nothing worked-so-far sits BEFORE 09-01 — a
    // purely-backward scan from the proposed date would miss this and wrongly accept it.
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 2;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-02', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-03', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-01' });
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'consecutive_limit' }]);
  });

  it('rejects a single proposal that merges two approved runs separated by exactly one gap day', () => {
    // maxConsecutiveDays=4, approved 09-01/09-02 and 09-04/09-05, gap at 09-03. Proposing 09-03
    // alone bridges the gap into one run of five (09-01..09-05), over the limit — again nothing
    // worked-so-far sits immediately before 09-03 in isolation, so this needs the forward scan too.
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 4;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-02', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-04', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-05', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-03' });
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'consecutive_limit' }]);
  });

  it('resets the run across a single missing day rather than tolerating the gap', () => {
    // A run-in of three approved days (08-30, 08-31, 09-01), then a genuine gap on 09-02 (no
    // shift, approved or proposed). The gap must fully reset the count: 09-03/04/05 form a FRESH
    // run of exactly 3 (at the limit) and all accept, but 09-06 extends that fresh run to 4 and
    // must reject. If the walk treated the single missing day as still-continuous, 09-06 would
    // wrongly look like day 4 of the pre-gap run's continuation and the whole batch would misbehave.
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 3;
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-30', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-08-31', startsAt: '08:00', endsAt: '16:00' },
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
      // 2026-09-02 is deliberately absent — the gap.
    );
    const day3 = assignment({ date: '2026-09-03' });
    const day4 = assignment({ date: '2026-09-04' });
    const day5 = assignment({ date: '2026-09-05' });
    const day6 = assignment({ date: '2026-09-06' });
    const result = validateAssignments([day3, day4, day5, day6], ctx);
    expect(result.accepted).toEqual([day3, day4, day5]);
    expect(result.rejected).toEqual([{ assignment: day6, reason: 'consecutive_limit' }]);
  });

  it('does not double-count a second slot on an already-worked date', () => {
    const ctx = baseCtx();
    ctx.employees[0].maxConsecutiveDays = 1;
    const a = assignment({ date: '2026-09-01', slotNumber: 1 });
    const b = assignment({ date: '2026-09-01', slotNumber: 2 }); // same date, different slot
    const result = validateAssignments([a, b], ctx);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([a, b]);
  });
});

describe('duplicate', () => {
  it('rejects a second proposal for the same employee/date/location/slot (dedupe-order determinism)', () => {
    const a = assignment();
    const b = assignment();
    const result = validateAssignments([a, b], baseCtx());
    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([{ assignment: b, reason: 'duplicate' }]);
  });

  it('rejects a proposal whose slot exactly matches an existing approved shift', () => {
    const ctx = baseCtx();
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-01', slotNumber: 1 }); // slot 1 window is 08:00-16:00
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'duplicate' }]);
  });

  it('reports duplicate rather than overlaps_approved for an exact-window match (determinism)', () => {
    const ctx = baseCtx();
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-01', slotNumber: 1 });
    const result = validateAssignments([a], ctx);
    expect(result.rejected[0].reason).toBe('duplicate');
  });

  it('treats the same (employee, date, slotNumber) as a duplicate even across locations', () => {
    // The plan's duplicate key is (employee, date, slotNumber) with no locationId component —
    // slotNumber is a conceptual time-of-day slot, and one person cannot fill it twice in a day.
    const ctx = baseCtx();
    ctx.locations.push({ id: 'locB', slots: [{ slotNumber: 1, startsAt: '08:00', endsAt: '16:00' }] });
    ctx.staffing.push(
      ...Array.from({ length: 7 }, (_, weekday) => ({ locationId: 'locB', weekday, peopleNeeded: 1 })),
    );
    const a = assignment({ locationId: 'locA', slotNumber: 1 });
    const b = assignment({ locationId: 'locB', slotNumber: 1 });
    const result = validateAssignments([a, b], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([{ assignment: b, reason: 'duplicate' }]);
  });

  it('does not treat different slot numbers at different locations as a duplicate', () => {
    const ctx = baseCtx();
    ctx.locations.push({ id: 'locB', slots: [{ slotNumber: 1, startsAt: '08:00', endsAt: '16:00' }] });
    ctx.staffing.push(
      ...Array.from({ length: 7 }, (_, weekday) => ({ locationId: 'locB', weekday, peopleNeeded: 1 })),
    );
    const a = assignment({ locationId: 'locA', slotNumber: 2 });
    const b = assignment({ locationId: 'locB', slotNumber: 1 });
    const result = validateAssignments([a, b], ctx);
    expect(result.rejected).toEqual([]);
  });
});

describe('overlaps_approved', () => {
  it('rejects a proposal whose window partially overlaps an approved shift at a different location', () => {
    const ctx = baseCtx();
    ctx.locations.push({ id: 'locB', slots: [{ slotNumber: 1, startsAt: '12:00', endsAt: '20:00' }] });
    ctx.staffing.push(
      ...Array.from({ length: 7 }, (_, weekday) => ({ locationId: 'locB', weekday, peopleNeeded: 1 })),
    );
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ locationId: 'locB', date: '2026-09-01', slotNumber: 1 }); // 12:00-20:00 overlaps 08:00-16:00
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'overlaps_approved' }]);
  });

  it('allows back-to-back windows that only touch (half-open)', () => {
    const ctx = baseCtx();
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const a = assignment({ date: '2026-09-01', slotNumber: 2 }); // slot 2 is 16:00-22:00, touches but does not overlap
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([]);
  });
});

describe('staffing_exceeded', () => {
  it('rejects once the accepted headcount for a (location, date, slot) meets peopleNeeded', () => {
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    // peopleNeeded is 1 for every weekday in baseCtx.
    const a = assignment({ employeeId: 'e1' });
    const b = assignment({ employeeId: 'e2' }); // same location/date/slot, second person
    const result = validateAssignments([a, b], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([{ assignment: b, reason: 'staffing_exceeded' }]);
  });

  it('treats a missing staffing row as peopleNeeded=0, rejecting everything there', () => {
    const ctx = baseCtx();
    ctx.staffing = []; // no staffing configured anywhere
    const a = assignment();
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'staffing_exceeded' }]);
  });

  it('tracks staffing per slot independently, not per location as a whole', () => {
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    const a = assignment({ employeeId: 'e1', slotNumber: 1 });
    const b = assignment({ employeeId: 'e2', slotNumber: 2 }); // different slot, own headcount
    const result = validateAssignments([a, b], ctx);
    expect(result.accepted).toEqual([a, b]);
    expect(result.rejected).toEqual([]);
  });

  it('gives each calendar date its own headcount even on the same weekday', () => {
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    // 2026-09-01 and 2026-09-08 are both Tuesdays — one person each, not shared capacity.
    const a = assignment({ employeeId: 'e1', date: '2026-09-01' });
    const b = assignment({ employeeId: 'e2', date: '2026-09-08' });
    const result = validateAssignments([a, b], ctx);
    expect(result.accepted).toEqual([a, b]);
    expect(result.rejected).toEqual([]);
  });

  it('counts an approved shift toward headcount, rejecting a proposal that would put two heads in a one-person slot', () => {
    // peopleNeeded=1 (baseCtx default). e1 already has an APPROVED shift filling slot 1's window
    // on 2026-09-01. A proposal for a different employee in that same location/date/slot must
    // reject — the approved occupant already consumed the only opening.
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const b = assignment({ employeeId: 'e2', date: '2026-09-01', slotNumber: 1 });
    const result = validateAssignments([b], ctx);
    expect(result.rejected).toEqual([{ assignment: b, reason: 'staffing_exceeded' }]);
  });

  it('accepts a proposal that fills the remaining opening alongside an approved shift, then rejects the next', () => {
    // peopleNeeded=2. One approved shift plus one accepted proposal exactly fills the slot; a
    // second proposal is the third head and must reject.
    const ctx = baseCtx();
    ctx.staffing = ctx.staffing.map((s) => ({ ...s, peopleNeeded: 2 }));
    ctx.employees.push(
      { id: 'e2', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] },
      { id: 'e3', active: true, maxConsecutiveDays: 5, homeLocationIds: ['locA'] },
    );
    ctx.approvedShifts.push(
      { employeeId: 'e1', locationId: 'locA', workDate: '2026-09-01', startsAt: '08:00', endsAt: '16:00' },
    );
    const b = assignment({ employeeId: 'e2', date: '2026-09-01', slotNumber: 1 });
    const c = assignment({ employeeId: 'e3', date: '2026-09-01', slotNumber: 1 });
    const result = validateAssignments([b, c], ctx);
    expect(result.accepted).toEqual([b]);
    expect(result.rejected).toEqual([{ assignment: c, reason: 'staffing_exceeded' }]);
  });

  it('does not count an approved shift whose window matches no slot toward staffing headcount', () => {
    // The approved shift's window (23:00-23:30) matches neither slot's startsAt and does not
    // overlap slot 1's window (08:00-16:00), so it sits outside slot accounting entirely — same
    // as the grid's shiftAt fallback for an unconfigured window. It must not consume the one
    // opening peopleNeeded=1 provides for slot 1.
    const ctx = baseCtx();
    ctx.approvedShifts.push(
      { employeeId: 'e2', locationId: 'locA', workDate: '2026-09-01', startsAt: '23:00', endsAt: '23:30' },
    );
    const a = assignment({ date: '2026-09-01', slotNumber: 1 });
    const result = validateAssignments([a], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([]);
  });
});

describe('flags', () => {
  it('flags off_home when the location is not one of the employee home locations', () => {
    const ctx = baseCtx();
    ctx.employees[0].homeLocationIds = ['locB'];
    const a = assignment({ locationId: 'locA' });
    const result = validateAssignments([a], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.flags).toEqual([{ assignment: a, flag: 'off_home' }]);
  });

  it('does not flag off_home when the location is a home location', () => {
    const ctx = baseCtx();
    ctx.employees[0].homeLocationIds = ['locA'];
    const a = assignment({ locationId: 'locA' });
    const result = validateAssignments([a], ctx);
    expect(result.flags).toEqual([]);
  });

  it('flags off_home for every assignment when the employee has no home locations', () => {
    const ctx = baseCtx();
    ctx.employees[0].homeLocationIds = [];
    const a = assignment();
    const result = validateAssignments([a], ctx);
    expect(result.flags).toEqual([{ assignment: a, flag: 'off_home' }]);
  });

  it('flags preferred_day_off when the date is a preferred day off', () => {
    const ctx = baseCtx();
    ctx.preferredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' });
    const a = assignment({ locationId: 'locA' }); // home location, so only the preferred flag fires
    const result = validateAssignments([a], ctx);
    expect(result.flags).toEqual([{ assignment: a, flag: 'preferred_day_off' }]);
  });

  it('flags never reject: a preferred day off still accepts the assignment', () => {
    const ctx = baseCtx();
    ctx.preferredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' });
    const a = assignment();
    const result = validateAssignments([a], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.rejected).toEqual([]);
  });

  it('both flags co-occur as two separate entries', () => {
    const ctx = baseCtx();
    ctx.employees[0].homeLocationIds = ['locB']; // locA is off-home
    ctx.preferredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' });
    const a = assignment({ locationId: 'locA', date: '2026-09-01' });
    const result = validateAssignments([a], ctx);
    expect(result.accepted).toEqual([a]);
    expect(result.flags).toEqual([
      { assignment: a, flag: 'off_home' },
      { assignment: a, flag: 'preferred_day_off' },
    ]);
  });

  it('produces no flags for a rejected assignment', () => {
    const ctx = baseCtx();
    ctx.employees[0].homeLocationIds = ['locB']; // would be off_home if accepted
    ctx.requiredDaysOff.push({ employeeId: 'e1', date: '2026-09-01' }); // but this rejects it outright
    const a = assignment({ locationId: 'locA', date: '2026-09-01' });
    const result = validateAssignments([a], ctx);
    expect(result.rejected).toEqual([{ assignment: a, reason: 'required_day_off' }]);
    expect(result.flags).toEqual([]);
  });
});

describe('mixed batches', () => {
  it('processes each employee independently: one accepted, one rejected, in the same call', () => {
    const ctx = baseCtx();
    ctx.employees.push({ id: 'e2', active: false, maxConsecutiveDays: 5, homeLocationIds: ['locA'] });
    const good = assignment({ employeeId: 'e1' });
    const bad = assignment({ employeeId: 'e2', slotNumber: 2 });
    const result = validateAssignments([good, bad], ctx);
    expect(result.accepted).toEqual([good]);
    expect(result.rejected).toEqual([{ assignment: bad, reason: 'inactive_employee' }]);
  });
});
