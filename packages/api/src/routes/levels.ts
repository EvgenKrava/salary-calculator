import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { levels, employees } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  ratePerDay: z.number().nonnegative(),
});
const updateSchema = z
  .object({ name: z.string().min(1), ratePerDay: z.number().nonnegative() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type LevelRow = typeof levels.$inferSelect;
function toDto(row: LevelRow) {
  return { id: row.id, name: row.name, ratePerDay: Number(row.ratePerDay) };
}

export function createLevelRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Reads are manager+admin; writes stay admin-only.
   *
   * Same reasoning as locations: setting the rate for a level is an admin decision, but
   * managing employees is a manager job (design §2) and an employee's level has to be
   * *shown and chosen* by name on that screen. Note this exposes `ratePerDay` to managers —
   * acceptable, because a manager already sees every employee's computed pay in a salary run.
   */
  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(levels);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(levels).where(eq(levels.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'level not found')));
  });

  // Everything below mutates setup data and remains admin-only.
  routes.use('*', requireRole('admin'));

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(levels).where(eq(levels.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'level name already exists' });
    const [row] = await db
      .insert(levels)
      .values({ name: body.name, ratePerDay: String(body.ratePerDay) })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof levels.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.ratePerDay !== undefined) patch.ratePerDay = String(body.ratePerDay);
    const [row] = await db
      .update(levels)
      .set(patch)
      .where(eq(levels.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'level not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const [{ value: refs }] = await db
      .select({ value: count() })
      .from(employees)
      .where(eq(employees.levelId, id));
    if (refs > 0) throw new HTTPException(409, { message: 'level is referenced by employees' });
    const [row] = await db.delete(levels).where(eq(levels.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'level not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}