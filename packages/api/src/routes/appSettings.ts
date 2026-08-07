import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { appSettings } from '../schema';

/**
 * Standing configuration — one row, set once, applies until changed.
 *
 * Readable by managers because the schedule grid shows each person's remaining allowance;
 * writable by admins only, because a limit change alters what the whole chain may request.
 */
const patchSchema = z
  .object({
    requiredDaysOffPerMonth: z.number().int().min(0).optional(),
    preferredDaysOffPerMonth: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

type SettingsRow = typeof appSettings.$inferSelect;
function toDto(row: SettingsRow) {
  return {
    requiredDaysOffPerMonth: row.requiredDaysOffPerMonth,
    preferredDaysOffPerMonth: row.preferredDaysOffPerMonth,
  };
}

/** Read the single settings row, which the migration guarantees exists. */
export async function loadSettings(db: Db): Promise<SettingsRow> {
  const [row] = await db.select().from(appSettings);
  if (!row) throw new HTTPException(500, { message: 'app settings row is missing' });
  return row;
}

export function createAppSettingsRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', requireRole('manager', 'admin'), async (c) => c.json(toDto(await loadSettings(db))));

  routes.patch('/', requireRole('admin'), async (c) => {
    const body = await readJson(c, patchSchema);
    const [row] = await db.update(appSettings).set(body).returning();
    return c.json(toDto(row));
  });

  return routes;
}
