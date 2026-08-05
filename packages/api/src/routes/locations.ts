import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { locations } from '../schema';

const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');

const createSchema = z
  .object({
    name: z.string().min(1),
    opensAt: timeString,
    closesAt: timeString,
  })
  .refine((v) => v.closesAt > v.opensAt, { message: 'closesAt must be after opensAt' });

const updateSchema = z
  .object({ name: z.string().min(1), opensAt: timeString, closesAt: timeString })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type LocationRow = typeof locations.$inferSelect;
function toDto(row: LocationRow) {
  return { id: row.id, name: row.name, opensAt: row.opensAt.slice(0, 5), closesAt: row.closesAt.slice(0, 5) };
}

export function createLocationRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Reads are manager+admin; writes stay admin-only.
   *
   * Managing locations is an admin job (design §2), but *naming* one is unavoidable for
   * managers: the shifts, revenue, and salary-run screens all render a location column, and
   * shifts/revenue are manager-scoped routes. With reads gated to admin, a manager's
   * `GET /api/locations` 403s and every location silently renders as '—' — the data looks
   * present but anonymous, which is worse than an error.
   */
  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(locations);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', requireRole('manager', 'admin'), async (c) => {
    const rows = await db.select().from(locations).where(eq(locations.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'location not found')));
  });

  // Everything below mutates setup data and remains admin-only.
  routes.use('*', requireRole('admin'));

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(locations).where(eq(locations.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'location name already exists' });
    const [row] = await db
      .insert(locations)
      .values({ name: body.name, opensAt: body.opensAt, closesAt: body.closesAt })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof locations.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.opensAt !== undefined) patch.opensAt = body.opensAt;
    if (body.closesAt !== undefined) patch.closesAt = body.closesAt;

    const current = await db.select().from(locations).where(eq(locations.id, id));
    const existing = getOr404(current, 'location not found');
    const opensAt = patch.opensAt ?? existing.opensAt.slice(0, 5);
    const closesAt = patch.closesAt ?? existing.closesAt.slice(0, 5);
    if (closesAt <= opensAt) throw new HTTPException(400, { message: 'closesAt must be after opensAt' });

    const [row] = await db.update(locations).set(patch).where(eq(locations.id, id)).returning();
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
