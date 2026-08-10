import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { payRates } from '../schema';

const putSchema = z.object({
  levelId: z.string().uuid(),
  locationId: z.string().uuid(),
  ratePerDay: z.number().nonnegative(),
  revenuePercent: z.number().min(0).max(1).default(0),
});

type PayRateRow = typeof payRates.$inferSelect;
function toDto(row: PayRateRow) {
  return {
    levelId: row.levelId,
    locationId: row.locationId,
    ratePerDay: Number(row.ratePerDay),
    revenuePercent: Number(row.revenuePercent),
  };
}

/**
 * The (level, location) pay matrix. Reads are manager+admin (a manager needs to see what a
 * shift will pay before approving it); writes stay admin-only, same split as levels/locations.
 */
export function createPayRateRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(payRates);
    return c.json(rows.map(toDto));
  });

  routes.use('*', requireRole('admin'));

  routes.put('/', async (c) => {
    const body = await readJson(c, putSchema);
    const [row] = await db
      .insert(payRates)
      .values({
        levelId: body.levelId,
        locationId: body.locationId,
        ratePerDay: String(body.ratePerDay),
        revenuePercent: String(body.revenuePercent),
      })
      .onConflictDoUpdate({
        target: [payRates.levelId, payRates.locationId],
        set: { ratePerDay: String(body.ratePerDay), revenuePercent: String(body.revenuePercent) },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/', async (c) => {
    const levelId = c.req.query('levelId');
    const locationId = c.req.query('locationId');
    if (!levelId || !locationId) {
      throw new HTTPException(400, { message: 'levelId and locationId are required' });
    }
    const deleted = await db
      .delete(payRates)
      .where(and(eq(payRates.levelId, levelId), eq(payRates.locationId, locationId)))
      .returning();
    return c.json({ deleted: deleted.length > 0 });
  });

  return routes;
}
