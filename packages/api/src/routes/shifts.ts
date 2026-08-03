import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { currentEmployee } from '../http/employeeContext';
import { shifts, locations } from '../schema';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const requestSchema = z.object({ locationId: z.string().uuid(), workDate: dateString });

type ShiftRow = typeof shifts.$inferSelect;
function toDto(row: ShiftRow) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    locationId: row.locationId,
    workDate: row.workDate,
    status: row.status,
    source: row.source,
  };
}

export function createShiftRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  async function requireLocation(locationId: string): Promise<void> {
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
  }

  async function assertNoShiftThatDay(employeeId: string, workDate: string): Promise<void> {
    const existing = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.employeeId, employeeId), eq(shifts.workDate, workDate)));
    if (existing.length > 0) throw new HTTPException(409, { message: 'a shift already exists for that day' });
  }

  routes.post('/requests', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const body = await readJson(c, requestSchema);
    await requireLocation(body.locationId);
    await assertNoShiftThatDay(employee.id, body.workDate);
    const [row] = await db
      .insert(shifts)
      .values({
        employeeId: employee.id,
        locationId: body.locationId,
        workDate: body.workDate,
        status: 'requested',
        source: 'native',
      })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const rows = await db.select().from(shifts).where(eq(shifts.employeeId, employee.id));
    return c.json(rows.map(toDto));
  });

  return routes;
}