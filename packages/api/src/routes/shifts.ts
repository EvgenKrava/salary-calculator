import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { currentEmployee } from '../http/employeeContext';
import { isUniqueViolation } from '../http/dbErrors';
import { shifts, locations, employees } from '../schema';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');
const requestSchema = z.object({
  locationId: z.string().uuid(),
  workDate: dateString,
  startsAt: timeString.optional(),
  endsAt: timeString.optional(),
});
const assignSchema = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
  workDate: dateString,
  startsAt: timeString.optional(),
  endsAt: timeString.optional(),
  status: z.enum(['requested', 'approved']).default('approved'),
});

type ShiftRow = typeof shifts.$inferSelect;
function toDto(row: ShiftRow) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    locationId: row.locationId,
    workDate: row.workDate,
    startsAt: row.startsAt.slice(0, 5),
    endsAt: row.endsAt.slice(0, 5),
    status: row.status,
    source: row.source,
  };
}

export function createShiftRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  async function loadLocation(locationId: string) {
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
    return rows[0];
  }

  async function resolveWindow(
    locationId: string,
    startsAt?: string,
    endsAt?: string,
  ): Promise<{ startsAt: string; endsAt: string }> {
    const location = await loadLocation(locationId);
    const start = startsAt ?? location.opensAt.slice(0, 5);
    const end = endsAt ?? location.closesAt.slice(0, 5);
    if (end <= start) throw new HTTPException(400, { message: 'endsAt must be after startsAt' });
    return { startsAt: start, endsAt: end };
  }

  async function requireEmployee(employeeId: string): Promise<void> {
    const rows = await db.select().from(employees).where(eq(employees.id, employeeId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
  }

  function shiftIdParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!id || !z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'shift not found' });
    return id;
  }

  // Two approved shifts for the same employee at the same location-day whose windows
  // overlap would inflate the calculation's proration denominator and silently underpay
  // every other person working that day. The composite UNIQUE only blocks an identical
  // starts_at, so this must be checked explicitly.
  async function assertNoOverlap(
    employeeId: string,
    locationId: string,
    workDate: string,
    startsAt: string,
    endsAt: string,
    excludeShiftId?: string,
  ): Promise<void> {
    const sameDay = await db
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.employeeId, employeeId),
          eq(shifts.locationId, locationId),
          eq(shifts.workDate, workDate),
          eq(shifts.status, 'approved'),
        ),
      );
    // Half-open comparison: touching windows (08:00-12:00 and 12:00-16:00) do NOT overlap.
    const clash = sameDay.some(
      (s) =>
        s.id !== excludeShiftId &&
        startsAt < s.endsAt.slice(0, 5) &&
        s.startsAt.slice(0, 5) < endsAt,
    );
    if (clash) {
      throw new HTTPException(409, { message: 'overlaps an existing approved shift' });
    }
  }

  routes.post('/requests', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const body = await readJson(c, requestSchema);
    const window = await resolveWindow(body.locationId, body.startsAt, body.endsAt);
    try {
      const [row] = await db
        .insert(shifts)
        .values({
          employeeId: employee.id,
          locationId: body.locationId,
          workDate: body.workDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          status: 'requested',
          source: 'native',
        })
        .returning();
      return c.json(toDto(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'a shift already exists for that day' });
      throw err;
    }
  });

  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const rows = await db.select().from(shifts).where(eq(shifts.employeeId, employee.id));
    return c.json(rows.map(toDto));
  });

  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const filters: SQL[] = [];
    const status = c.req.query('status');
    if (status === 'requested' || status === 'approved' || status === 'rejected') {
      filters.push(eq(shifts.status, status));
    }
    const from = c.req.query('from');
    if (from !== undefined) {
      if (!dateString.safeParse(from).success) throw new HTTPException(400, { message: 'invalid "from" date' });
      filters.push(gte(shifts.workDate, from));
    }
    const to = c.req.query('to');
    if (to !== undefined) {
      if (!dateString.safeParse(to).success) throw new HTTPException(400, { message: 'invalid "to" date' });
      filters.push(lte(shifts.workDate, to));
    }
    const rows = filters.length
      ? await db.select().from(shifts).where(and(...filters))
      : await db.select().from(shifts);
    return c.json(rows.map(toDto));
  });

  routes.post('/', requireRole('manager', 'admin'), async (c) => {
    const body = await readJson(c, assignSchema);
    await requireEmployee(body.employeeId);
    const window = await resolveWindow(body.locationId, body.startsAt, body.endsAt);
    if (body.status === 'approved') {
      await assertNoOverlap(body.employeeId, body.locationId, body.workDate, window.startsAt, window.endsAt);
    }
    try {
      const [row] = await db
        .insert(shifts)
        .values({
          employeeId: body.employeeId,
          locationId: body.locationId,
          workDate: body.workDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          status: body.status,
          source: 'native',
        })
        .returning();
      return c.json(toDto(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'a shift already exists for that day' });
      throw err;
    }
  });

  routes.post('/:id/approve', requireRole('manager', 'admin'), async (c) => {
    const id = shiftIdParam(c);
    const [existing] = await db.select().from(shifts).where(eq(shifts.id, id));
    if (!existing) throw new HTTPException(404, { message: 'shift not found' });
    await assertNoOverlap(
      existing.employeeId,
      existing.locationId,
      existing.workDate,
      existing.startsAt.slice(0, 5),
      existing.endsAt.slice(0, 5),
      existing.id,
    );
    const [row] = await db
      .update(shifts)
      .set({ status: 'approved' })
      .where(eq(shifts.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json(toDto(row));
  });

  routes.post('/:id/reject', requireRole('manager', 'admin'), async (c) => {
    const id = shiftIdParam(c);
    const [row] = await db
      .update(shifts)
      .set({ status: 'rejected' })
      .where(eq(shifts.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', requireRole('manager', 'admin'), async (c) => {
    const id = shiftIdParam(c);
    const [row] = await db.delete(shifts).where(eq(shifts.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
