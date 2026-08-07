import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { toSqlTime } from '@salary/core';
import { requireRole } from '../auth/middleware';
import { isForeignKeyViolation } from '../http/dbErrors';
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

  /*
   * The mutating routes are admin-only, guarded individually.
   *
   * This was `routes.use('*', requireRole('admin'))`, which reads as "everything below" but is
   * actually scoped by PATH, not by position — and this group is mounted at `/api/locations`, a
   * prefix of the separately-mounted `/api/locations/:locationId/slots`. So the wildcard also
   * gated the nested slots group to admin, invisibly, from outside the file that defines it: a
   * manager reading slot windows got a 403 that no rule in shiftSlots.ts accounted for. Per-route
   * guards cannot reach into another router.
   */
  routes.post('/', requireRole('admin'), async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(locations).where(eq(locations.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'location name already exists' });
    const [row] = await db
      .insert(locations)
      .values({ name: body.name, opensAt: toSqlTime(body.opensAt), closesAt: toSqlTime(body.closesAt) })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof locations.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.opensAt !== undefined) patch.opensAt = toSqlTime(body.opensAt);
    if (body.closesAt !== undefined) patch.closesAt = toSqlTime(body.closesAt);

    const current = await db.select().from(locations).where(eq(locations.id, id));
    const existing = getOr404(current, 'location not found');
    const opensAt = (patch.opensAt ?? existing.opensAt).slice(0, 5);
    const closesAt = (patch.closesAt ?? existing.closesAt).slice(0, 5);
    if (closesAt <= opensAt) throw new HTTPException(400, { message: 'closesAt must be after opensAt' });

    const [row] = await db.update(locations).set(patch).where(eq(locations.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'location not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', requireRole('admin'), async (c) => {
    try {
      const [row] = await db.delete(locations).where(eq(locations.id, c.req.param('id'))).returning();
      if (!row) throw new HTTPException(404, { message: 'location not found' });
      return c.json({ deleted: row.id });
    } catch (err) {
      // A location with revenue, shifts, or slot windows cannot be deleted — the FK is
      // deliberate, because those records are payroll history. Say so instead of leaking a
      // 500: the manager's actual options are to remove the dependent rows or leave the
      // location in place, and a generic "internal" error tells them neither.
      if (err instanceof HTTPException) throw err;
      if (isForeignKeyViolation(err)) {
        throw new HTTPException(409, {
          message: 'location still has revenue, shifts or shift slots and cannot be deleted',
        });
      }
      throw err;
    }
  });

  return routes;
}
