import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';

describe('drizzle schema against the core migration', () => {
  it('inserts and reads back a level, location, and employee', async () => {
    const { db } = await createTestDb();

    const [level] = await db
      .insert(levels)
      .values({ name: 'Junior', ratePerHour: '20.00' })
      .returning();
    await db.insert(locations).values({ name: 'Downtown', standardShiftHours: '8.00' });
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

  it('enforces the employee-per-day uniqueness through drizzle inserts', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '10.00' }).returning();
    const [loc] = await db.insert(locations).values({ name: 'Loc', standardShiftHours: '8.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'Bob', levelId: level.id }).returning();

    const { shifts } = await import('../src/schema');
    await db.insert(shifts).values({ employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01' });
    await expect(
      db.insert(shifts).values({ employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01' }),
    ).rejects.toThrow();
  });
});