import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { locationShiftSlots, locations } from '../schema';

const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');
const windowSchema = z
  .object({ startsAt: timeString, endsAt: timeString })
  .refine((v) => v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt' });

type SlotRow = typeof locationShiftSlots.$inferSelect;
function toDto(row: SlotRow) {
  return {
    locationId: row.locationId,
    slotNumber: row.slotNumber,
    startsAt: row.startsAt.slice(0, 5),
    endsAt: row.endsAt.slice(0, 5),
  };
}

export function createShiftSlotRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('admin'));

  async function requireLocation(locationId: string): Promise<void> {
    if (!z.string().uuid().safeParse(locationId).success) {
      throw new HTTPException(400, { message: 'invalid locationId' });
    }
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
  }

  function slotNumberParam(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new HTTPException(400, { message: 'slot number must be a positive integer' });
    }
    return n;
  }

  routes.get('/', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const rows = await db
      .select()
      .from(locationShiftSlots)
      .where(eq(locationShiftSlots.locationId, locationId));
    return c.json(rows.map(toDto));
  });

  /**
   * A slot window must fall inside the location's own working hours — otherwise the
   * importer would happily produce shifts for hours the shop is shut. The DB constrains
   * the window's shape (ordered, whole minutes, < 24:00) but cannot compare it to the
   * parent location's hours, so it is enforced here.
   */
  async function assertWithinLocationHours(
    locationId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<void> {
    const [location] = await db.select().from(locations).where(eq(locations.id, locationId));
    const opensAt = location.opensAt.slice(0, 5);
    const closesAt = location.closesAt.slice(0, 5);
    if (startsAt < opensAt || endsAt > closesAt) {
      throw new HTTPException(400, {
        message: `slot window must fall within the location hours ${opensAt}-${closesAt}`,
      });
    }
  }

  // PUT is an upsert so re-configuring a slot is idempotent.
  routes.put('/:slotNumber', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const slotNumber = slotNumberParam(c.req.param('slotNumber')!);
    const body = await readJson(c, windowSchema);
    await assertWithinLocationHours(locationId, body.startsAt, body.endsAt);
    const [row] = await db
      .insert(locationShiftSlots)
      .values({ locationId, slotNumber, startsAt: body.startsAt, endsAt: body.endsAt })
      .onConflictDoUpdate({
        target: [locationShiftSlots.locationId, locationShiftSlots.slotNumber],
        set: { startsAt: body.startsAt, endsAt: body.endsAt },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/:slotNumber', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const slotNumber = slotNumberParam(c.req.param('slotNumber')!);
    const [row] = await db
      .delete(locationShiftSlots)
      .where(
        and(eq(locationShiftSlots.locationId, locationId), eq(locationShiftSlots.slotNumber, slotNumber)),
      )
      .returning();
    if (!row) throw new HTTPException(404, { message: 'slot not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
