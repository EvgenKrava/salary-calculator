import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { isUniqueViolation } from '../http/dbErrors';
import { dailyRevenue, locations } from '../schema';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const createSchema = z.object({
  locationId: z.string().uuid(),
  revenueDate: dateString,
  amount: z.number().nonnegative(),
});
const updateSchema = z.object({ amount: z.number().nonnegative() });

type RevenueRow = typeof dailyRevenue.$inferSelect;
function toDto(row: RevenueRow) {
  return {
    id: row.id,
    locationId: row.locationId,
    revenueDate: row.revenueDate,
    amount: Number(row.amount),
    source: row.source,
    status: row.status,
  };
}

export function createRevenueRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!id || !z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'revenue entry not found' });
    return id;
  }

  routes.get('/', async (c) => {
    const filters: SQL[] = [];
    const locationId = c.req.query('locationId');
    if (locationId && z.string().uuid().safeParse(locationId).success) filters.push(eq(dailyRevenue.locationId, locationId));
    const from = c.req.query('from');
    if (from !== undefined) {
      if (!dateString.safeParse(from).success) throw new HTTPException(400, { message: 'invalid "from" date' });
      filters.push(gte(dailyRevenue.revenueDate, from));
    }
    const to = c.req.query('to');
    if (to !== undefined) {
      if (!dateString.safeParse(to).success) throw new HTTPException(400, { message: 'invalid "to" date' });
      filters.push(lte(dailyRevenue.revenueDate, to));
    }
    const rows = filters.length
      ? await db.select().from(dailyRevenue).where(and(...filters))
      : await db.select().from(dailyRevenue);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const rows = await db.select().from(dailyRevenue).where(eq(dailyRevenue.id, id));
    return c.json(toDto(getOr404(rows, 'revenue entry not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const loc = await db.select().from(locations).where(eq(locations.id, body.locationId));
    if (loc.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
    try {
      const [row] = await db
        .insert(dailyRevenue)
        .values({ locationId: body.locationId, revenueDate: body.revenueDate, amount: String(body.amount), source: 'manual', status: 'approved' })
        .returning();
      return c.json(toDto(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'revenue already recorded for that location and day' });
      throw err;
    }
  });

  routes.patch('/:id', async (c) => {
    const id = idParam(c);
    const body = await readJson(c, updateSchema);
    const [row] = await db
      .update(dailyRevenue)
      .set({ amount: String(body.amount) })
      .where(eq(dailyRevenue.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'revenue entry not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const id = idParam(c);
    const [row] = await db.delete(dailyRevenue).where(eq(dailyRevenue.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'revenue entry not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}