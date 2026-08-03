import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { locations } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  standardShiftHours: z.number().positive(),
});
const updateSchema = z
  .object({ name: z.string().min(1), standardShiftHours: z.number().positive() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type LocationRow = typeof locations.$inferSelect;
function toDto(row: LocationRow) {
  return { id: row.id, name: row.name, standardShiftHours: Number(row.standardShiftHours) };
}

export function createLocationRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(locations);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const rows = await db.select().from(locations).where(eq(locations.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'location not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(locations).where(eq(locations.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'location name already exists' });
    const [row] = await db
      .insert(locations)
      .values({ name: body.name, standardShiftHours: String(body.standardShiftHours) })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof locations.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.standardShiftHours !== undefined) patch.standardShiftHours = String(body.standardShiftHours);
    const [row] = await db
      .update(locations)
      .set(patch)
      .where(eq(locations.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'location not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const [row] = await db.delete(locations).where(eq(locations.id, c.req.param('id'))).returning();
    if (!row) throw new HTTPException(404, { message: 'location not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}