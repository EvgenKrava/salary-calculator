import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';

describe('drizzle schema against the core migration', () => {
  it('inserts and reads back a level, location, and employee', async () => {
    const { db } = await createTestDb();

    const [level] = await db
      .insert(levels)
      .values({ name: 'Junior', ratePerDay: '20.00' })
      .returning();
    await db.insert(locations).values({ name: 'Downtown', opensAt: '08:00', closesAt: '16:00' });
    const [employee] = await db
      .insert(employees)
      .values({ name: 'Alice', levelId: level.id, revenuePercent: '0.0500' })
      .returning();

    const found = await db.select().from(employees).where(eq(employees.id, employee.id));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Alice');
    expect(found[0].revenuePercent).toBe('0.0500'); // NUMERIC comes back as a string
    expect(found[0].active).toBe(true);
  });

  it('enforces the employee/day/location/start-time uniqueness through drizzle inserts', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [loc] = await db.insert(locations).values({ name: 'Loc', opensAt: '08:00', closesAt: '16:00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'Bob', levelId: level.id }).returning();

    const { shifts } = await import('../src/schema');
    await db.insert(shifts).values({
      employeeId: emp.id,
      locationId: loc.id,
      workDate: '2026-09-01',
      startsAt: '08:00',
      endsAt: '16:00',
    });
    await expect(
      db.insert(shifts).values({
        employeeId: emp.id,
        locationId: loc.id,
        workDate: '2026-09-01',
        startsAt: '08:00',
        endsAt: '16:00',
      }),
    ).rejects.toThrow();
  });
});

describe('schedule authoring tables', () => {
  it('accepts a draft shift and rejects an unknown status', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [loc] = await db.insert(locations).values({ name: '1', opensAt: '08:00', closesAt: '20:00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { shifts } = await import('../src/schema');

    const [row] = await db
      .insert(shifts)
      .values({
        employeeId: emp.id,
        locationId: loc.id,
        workDate: '2026-09-01',
        startsAt: '08:00:00',
        endsAt: '14:00:00',
        status: 'draft',
      })
      .returning();
    expect(row.status).toBe('draft');

    // The CHECK list in the migration must stay in step with the pgEnum in schema.ts.
    await expect(
      db.insert(shifts).values({
        employeeId: emp.id,
        locationId: loc.id,
        workDate: '2026-09-02',
        startsAt: '08:00:00',
        endsAt: '14:00:00',
        status: 'nonsense' as never,
      }),
    ).rejects.toThrow();
  });

  it('stores a day-off request and forbids two kinds on one date', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { dayOffRequests } = await import('../src/schema');

    await db.insert(dayOffRequests).values({
      employeeId: emp.id,
      requestDate: '2026-09-05',
      kind: 'required',
      createdBy: 'sub-1',
    });
    await expect(
      db.insert(dayOffRequests).values({
        employeeId: emp.id,
        requestDate: '2026-09-05',
        kind: 'preferred',
        createdBy: 'sub-1',
      }),
    ).rejects.toThrow();
  });

  it('rejects a day-off kind outside the CHECK list', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '10.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'A', levelId: level.id }).returning();
    const { dayOffRequests } = await import('../src/schema');
    await expect(
      db.insert(dayOffRequests).values({
        employeeId: emp.id,
        requestDate: '2026-09-06',
        kind: 'maybe' as never,
        createdBy: 'sub-1',
      }),
    ).rejects.toThrow();
  });

  it('ships exactly one settings row, and refuses a second', async () => {
    const { db } = await createTestDb();
    const { appSettings } = await import('../src/schema');
    const rows = await db.select().from(appSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0].requiredDaysOffPerMonth).toBe(2);
    expect(rows[0].preferredDaysOffPerMonth).toBe(4);
    // The single-row idiom must be enforced by the schema, not by convention.
    await expect(db.insert(appSettings).values({ id: true })).rejects.toThrow();
  });

  it('records a publication once per month', async () => {
    const { db } = await createTestDb();
    const { schedulePublications } = await import('../src/schema');
    await db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-1' });
    await expect(
      db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-2' }),
    ).rejects.toThrow();
  });
});