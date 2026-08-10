import { describe, it, expect } from 'vitest';
import { calculateSalaries } from '../src/calculateSalaries';
import type { CalcInput, PayPeriod } from '../src/types';

const PERIOD: PayPeriod = { start: '2026-08-01', end: '2026-08-15' };

function baseInput(): CalcInput {
  return {
    levels: [{ id: 'lvl1', name: 'Junior' }],
    locations: [{ id: 'locA', name: 'A', opensAt: '08:00', closesAt: '16:00' }],
    employees: [
      { id: 'e1', name: 'Alice', levelId: 'lvl1', cognitoSub: null, active: true },
    ],
    shifts: [
      {
        id: 's1', employeeId: 'e1', locationId: 'locA', workDate: '2026-08-02',
        startsAt: '08:00', endsAt: '16:00', status: 'approved', source: 'native',
      },
    ],
    dailyRevenue: [
      { locationId: 'locA', revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
    ],
    payRates: [{ levelId: 'lvl1', locationId: 'locA', ratePerDay: 20, revenuePercent: 0.05 }],
    bonuses: {},
  };
}

describe('calculateSalaries', () => {
  it('returns nothing for empty input', () => {
    const result = calculateSalaries(
      { levels: [], locations: [], employees: [], shifts: [], dailyRevenue: [], payRates: [], bonuses: {} },
      PERIOD,
    );
    expect(result.lines).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.missingRates).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it('computes hourly pay and revenue share for one shift', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({
      employeeId: 'e1',
      hourlyPay: 20, // full 8h working day => exactly the 20/day rate
      revenueShare: 50, // 0.05 * 1000
      bonus: 0,
      total: 70,
    });
    expect(result.blocked).toBe(false);
  });

  it('pays hourly by actual hours worked', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // 4 hours instead of 8
    const result = calculateSalaries(input, PERIOD);
    // Day rate 20, pro-rated: 4h of an 8h working day is half a day.
    expect(result.lines[0].hourlyPay).toBe(10);
  });

  it('gives the whole day revenue share to the only person who worked it', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines[0].revenueShare).toBe(50); // 0.05 x 1000 x (8/8)
  });

  it('prorates revenue share by each person share of the hours', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice: 4h
    // Bob is a different level so he can carry a different revenuePercent at the same
    // location — revenuePercent now lives on the (level, location) cell, not the employee.
    input.levels.push({ id: 'lvl2', name: 'Senior' });
    input.payRates.push({ levelId: 'lvl2', locationId: 'locA', ratePerDay: 20, revenuePercent: 0.1 });
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl2', cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '12:00', endsAt: '16:00', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    const bob = result.lines.find((l) => l.employeeId === 'e2')!;
    // total hours that location-day = 8; each worked 4 => half of their own percent
    expect(alice.revenueShare).toBe(25); // 0.05 x 1000 x 4/8
    expect(bob.revenueShare).toBe(50); // 0.10 x 1000 x 4/8
    // Each worked 4h of an 8h working day => half the day rate each. This is the case the
    // pro-rating exists for: paying both a full day would double the day's wage bill.
    expect(alice.hourlyPay).toBe(10);
    expect(bob.hourlyPay).toBe(10);
  });

  it('sums multiple shifts for one employee in a day across locations', () => {
    const input = baseInput();
    input.locations.push({ id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' });
    input.payRates.push({ levelId: 'lvl1', locationId: 'locB', ratePerDay: 20, revenuePercent: 0.05 });
    input.shifts[0].endsAt = '12:00'; // 4h at A
    input.shifts.push({
      id: 's3', employeeId: 'e1', locationId: 'locB', workDate: '2026-08-02',
      startsAt: '13:00', endsAt: '17:00', status: 'approved', source: 'native',
    });
    input.dailyRevenue.push({ locationId: 'locB', revenueDate: '2026-08-02', amount: 500, status: 'approved' });
    const result = calculateSalaries(input, PERIOD);
    // 4h of locA's 8h day (=10) + 4h of locB's 12h day (=6.67). The divisor is each
    // location's OWN working day, so the same 4 hours are worth different amounts.
    expect(result.lines[0].hourlyPay).toBe(16.67);
    // sole worker at each location that day => full percent of each
    expect(result.lines[0].revenueShare).toBe(75); // 0.05 x 1000 + 0.05 x 500
  });

  it('excludes non-approved shifts from the proration denominator', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice 4h approved
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '12:00', endsAt: '16:00', status: 'requested', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    // Bob's requested shift does not count: Alice is the only approved worker => full percent
    expect(alice.revenueShare).toBe(50);
  });

  it('throws on a shift whose end is not after its start', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '08:00';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/end must be after start/);
  });

  it('records a gap and blocks when revenue is missing for a worked day', () => {
    const input = baseInput();
    input.dailyRevenue = [];
    const result = calculateSalaries(input, PERIOD);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
    expect(result.blocked).toBe(true);
    // hourly pay still computed; missing revenue contributes 0 to the share.
    expect(result.lines[0].hourlyPay).toBe(20);
    expect(result.lines[0].revenueShare).toBe(0);
  });

  it('treats non-approved revenue as missing', () => {
    const input = baseInput();
    input.dailyRevenue[0].status = 'needs_review';
    const result = calculateSalaries(input, PERIOD);
    expect(result.blocked).toBe(true);
    expect(result.lines[0].revenueShare).toBe(0);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
  });

  it('skips inactive employees', () => {
    const input = baseInput();
    input.employees[0].active = false;
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines).toEqual([]);
  });

  it('ignores shifts outside the period', () => {
    const input = baseInput();
    input.shifts[0].workDate = '2026-08-20';
    input.dailyRevenue[0].revenueDate = '2026-08-20';
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(0);
    expect(result.lines[0].revenueShare).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it('ignores shifts that are not approved', () => {
    const input = baseInput();
    input.shifts[0].status = 'requested';
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it('adds the personal bonus into the total', () => {
    const input = baseInput();
    input.bonuses = { e1: 75.5 };
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].bonus).toBe(75.5);
    expect(result.lines[0].total).toBe(145.5); // 20 (full day) + 50 (share) + 75.5
  });

  it('rounds each component and keeps the total consistent', () => {
    const input = baseInput();
    input.payRates[0].revenuePercent = 0.0333;
    input.dailyRevenue[0].amount = 1000.126;
    const result = calculateSalaries(input, PERIOD);
    const line = result.lines[0];
    expect(line.revenueShare).toBe(33.3); // sole worker: 0.0333 x 1000.126 rounded
    expect(line.total).toBe(Math.round((line.hourlyPay + line.revenueShare + line.bonus) * 100) / 100);
  });

  it('records a gap for a missing-revenue day with one shift', () => {
    const input = baseInput();
    input.dailyRevenue = [];
    const result = calculateSalaries(input, PERIOD);
    expect(result.gaps).toEqual([{ employeeId: 'e1', locationId: 'locA', date: '2026-08-02' }]);
  });

  it('throws when a shift references an unknown location', () => {
    const input = baseInput();
    input.shifts[0].locationId = 'missing';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/unknown location/);
  });

  it('throws when an employee references an unknown level', () => {
    const input = baseInput();
    input.employees[0].levelId = 'missing';
    expect(() => calculateSalaries(input, PERIOD)).toThrow(/unknown level/);
  });

  it('prorates an uneven split by hours, not headcount', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '14:00'; // Alice: 6h
    // Bob is a different level at the same rate_per_day but a different revenuePercent, again
    // because revenuePercent is a (level, location) cell property, not an employee property.
    input.levels.push({ id: 'lvl2', name: 'Senior' });
    input.payRates.push({ levelId: 'lvl2', locationId: 'locA', ratePerDay: 20, revenuePercent: 0.1 });
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl2', cognitoSub: null, active: true,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '14:00', endsAt: '16:00', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    const bob = result.lines.find((l) => l.employeeId === 'e2')!;
    // A headcount split would give 25/50; the hours split must give 37.5/25.
    expect(alice.hourlyPay).toBe(15); // 6h of an 8h day => 3/4 of the 20/day rate
    expect(alice.revenueShare).toBe(37.5); // 0.05 x 1000 x 6/8
    expect(bob.hourlyPay).toBe(5); // 2h of an 8h day => a quarter of the 20/day rate
    expect(bob.revenueShare).toBe(25); // 0.10 x 1000 x 2/8
  });

  it('counts an inactive employee approved hours in the denominator', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice: 4h, active
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', cognitoSub: null, active: false,
    });
    input.shifts.push({
      id: 's2', employeeId: 'e2', locationId: 'locA', workDate: '2026-08-02',
      startsAt: '12:00', endsAt: '16:00', status: 'approved', source: 'native',
    });
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines).toHaveLength(1);
    const alice = result.lines.find((l) => l.employeeId === 'e1')!;
    expect(alice.revenueShare).toBe(25); // 0.05 x 1000 x 4/8 (Bob's hours still count in the denominator)
    expect(result.lines.find((l) => l.employeeId === 'e2')).toBeUndefined();
  });

  it('pays different rates and percents for the same person at two locations in one day', () => {
    // loc A: 12h day, 600/day, 5%; loc B: 12h day, 800/day, 10%. 6h at each.
    // revenue 1000 approved at each location; the employee is the only worker.
    // base = 600*(6/12) + 800*(6/12) = 300 + 400 = 700
    // share = 0.05*1000*(6/6) + 0.10*1000*(6/6) = 50 + 100 = 150
    const level = { id: 'lvl1', name: 'Junior' };
    const locA = { id: 'locA', name: 'A', opensAt: '08:00', closesAt: '20:00' };
    const locB = { id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' };
    const employee = { id: 'e1', name: 'Alice', levelId: level.id, cognitoSub: null, active: true };
    const input: CalcInput = {
      levels: [level],
      locations: [locA, locB],
      employees: [employee],
      shifts: [
        {
          id: 's1', employeeId: employee.id, locationId: locA.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
        {
          id: 's2', employeeId: employee.id, locationId: locB.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
      ],
      dailyRevenue: [
        { locationId: locA.id, revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
        { locationId: locB.id, revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
      ],
      payRates: [
        { levelId: level.id, locationId: locA.id, ratePerDay: 600, revenuePercent: 0.05 },
        { levelId: level.id, locationId: locB.id, ratePerDay: 800, revenuePercent: 0.1 },
      ],
      bonuses: {},
    };
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(700);
    expect(result.lines[0].revenueShare).toBe(150);
    expect(result.blocked).toBe(false);
  });

  it('reports a missing matrix cell as a blocking gap and pays nothing for that shift', () => {
    // Same fixture as above minus the (level, locB) cell. The locA shift still computes; the
    // locB shift contributes NOTHING to either component and lands in missingRates.
    const level = { id: 'lvl1', name: 'Junior' };
    const locA = { id: 'locA', name: 'A', opensAt: '08:00', closesAt: '20:00' };
    const locB = { id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' };
    const employee = { id: 'e1', name: 'Alice', levelId: level.id, cognitoSub: null, active: true };
    const input: CalcInput = {
      levels: [level],
      locations: [locA, locB],
      employees: [employee],
      shifts: [
        {
          id: 's1', employeeId: employee.id, locationId: locA.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
        {
          id: 's2', employeeId: employee.id, locationId: locB.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
      ],
      dailyRevenue: [
        { locationId: locA.id, revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
        { locationId: locB.id, revenueDate: '2026-08-02', amount: 1000, status: 'approved' },
      ],
      payRates: [
        { levelId: level.id, locationId: locA.id, ratePerDay: 600, revenuePercent: 0.05 },
        // no cell for (level, locB)
      ],
      bonuses: {},
    };
    const result = calculateSalaries(input, PERIOD);
    expect(result.missingRates).toEqual([{ levelId: level.id, locationId: locB.id }]);
    expect(result.blocked).toBe(true);
    expect(result.lines[0].hourlyPay).toBe(300); // locA half-day only
    // The missing-cell shift does not ALSO show up as a revenue gap — reporting the same
    // shift twice as two kinds of gap would be noise once the run is already blocked.
    expect(result.gaps).toEqual([]);
  });

  it('dedupes missingRates across shifts and employees sharing the cell', () => {
    const level = { id: 'lvl1', name: 'Junior' };
    const locB = { id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' };
    const alice = { id: 'e1', name: 'Alice', levelId: level.id, cognitoSub: null, active: true };
    const bob = { id: 'e2', name: 'Bob', levelId: level.id, cognitoSub: null, active: true };
    const input: CalcInput = {
      levels: [level],
      locations: [locB],
      employees: [alice, bob],
      shifts: [
        {
          id: 's1', employeeId: alice.id, locationId: locB.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
        {
          id: 's2', employeeId: alice.id, locationId: locB.id, workDate: '2026-08-03',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
        {
          id: 's3', employeeId: bob.id, locationId: locB.id, workDate: '2026-08-02',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
        {
          id: 's4', employeeId: bob.id, locationId: locB.id, workDate: '2026-08-03',
          startsAt: '08:00', endsAt: '14:00', status: 'approved', source: 'native',
        },
      ],
      dailyRevenue: [],
      payRates: [],
      bonuses: {},
    };
    const result = calculateSalaries(input, PERIOD);
    expect(result.missingRates).toEqual([{ levelId: level.id, locationId: locB.id }]);
    expect(result.blocked).toBe(true);
  });

  it('a configured cell with percent 0 pays rate only', () => {
    const input = baseInput();
    input.payRates[0].revenuePercent = 0;
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(20);
    expect(result.lines[0].revenueShare).toBe(0);
    expect(result.blocked).toBe(false);
  });
});
