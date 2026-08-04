import { describe, it, expect } from 'vitest';
import { calculateSalaries } from '../src/calculateSalaries';
import type { CalcInput, PayPeriod } from '../src/types';

const PERIOD: PayPeriod = { start: '2026-08-01', end: '2026-08-15' };

function baseInput(): CalcInput {
  return {
    levels: [{ id: 'lvl1', name: 'Junior', ratePerHour: 20 }],
    locations: [{ id: 'locA', name: 'A', opensAt: '08:00', closesAt: '16:00' }],
    employees: [
      { id: 'e1', name: 'Alice', levelId: 'lvl1', revenuePercent: 0.05, cognitoSub: null, active: true },
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
    bonuses: {},
  };
}

describe('calculateSalaries', () => {
  it('returns nothing for empty input', () => {
    const result = calculateSalaries(
      { levels: [], locations: [], employees: [], shifts: [], dailyRevenue: [], bonuses: {} },
      PERIOD,
    );
    expect(result.lines).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it('computes hourly pay and revenue share for one shift', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual({
      employeeId: 'e1',
      hourlyPay: 160, // 20 * 8
      revenueShare: 50, // 0.05 * 1000
      bonus: 0,
      total: 210,
    });
    expect(result.blocked).toBe(false);
  });

  it('pays hourly by actual hours worked', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // 4 hours instead of 8
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(80); // 20 x 4
  });

  it('gives the whole day revenue share to the only person who worked it', () => {
    const result = calculateSalaries(baseInput(), PERIOD);
    expect(result.lines[0].revenueShare).toBe(50); // 0.05 x 1000 x (8/8)
  });

  it('prorates revenue share by each person share of the hours', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice: 4h
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', revenuePercent: 0.1, cognitoSub: null, active: true,
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
    expect(alice.hourlyPay).toBe(80);
    expect(bob.hourlyPay).toBe(80);
  });

  it('sums multiple shifts for one employee in a day across locations', () => {
    const input = baseInput();
    input.locations.push({ id: 'locB', name: 'B', opensAt: '08:00', closesAt: '20:00' });
    input.shifts[0].endsAt = '12:00'; // 4h at A
    input.shifts.push({
      id: 's3', employeeId: 'e1', locationId: 'locB', workDate: '2026-08-02',
      startsAt: '13:00', endsAt: '17:00', status: 'approved', source: 'native',
    });
    input.dailyRevenue.push({ locationId: 'locB', revenueDate: '2026-08-02', amount: 500, status: 'approved' });
    const result = calculateSalaries(input, PERIOD);
    expect(result.lines[0].hourlyPay).toBe(160); // 20 x (4 + 4)
    // sole worker at each location that day => full percent of each
    expect(result.lines[0].revenueShare).toBe(75); // 0.05 x 1000 + 0.05 x 500
  });

  it('excludes non-approved shifts from the proration denominator', () => {
    const input = baseInput();
    input.shifts[0].endsAt = '12:00'; // Alice 4h approved
    input.employees.push({
      id: 'e2', name: 'Bob', levelId: 'lvl1', revenuePercent: 0.1, cognitoSub: null, active: true,
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
    expect(result.lines[0].hourlyPay).toBe(160);
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
    expect(result.lines[0].total).toBe(285.5); // 160 + 50 + 75.5
  });

  it('rounds each component and keeps the total consistent', () => {
    const input = baseInput();
    input.employees[0].revenuePercent = 0.0333;
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
});
