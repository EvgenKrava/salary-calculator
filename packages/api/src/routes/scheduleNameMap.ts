import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { scheduleNameMap, employees } from '../schema';

// A mapping either points at an employee or is explicitly ignored — never both, never
// neither, so a name can't silently resolve to nobody at import time.
const upsertSchema = z
  .object({
    sourceName: z.string().min(1),
    employeeId: z.string().uuid().optional(),
    ignored: z.boolean().optional(),
  })
  .refine((v) => (v.employeeId !== undefined) !== (v.ignored === true), {
    message: 'provide exactly one of employeeId or ignored: true',
  });

type MapRow = typeof scheduleNameMap.$inferSelect;
function toDto(row: MapRow) {
  return { sourceName: row.sourceName, employeeId: row.employeeId, ignored: row.ignored };
}

export function createScheduleNameMapRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(scheduleNameMap);
    return c.json(rows.map(toDto));
  });

  routes.put('/', async (c) => {
    const body = await readJson(c, upsertSchema);
    if (body.employeeId !== undefined) {
      const emp = await db.select().from(employees).where(eq(employees.id, body.employeeId));
      if (emp.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
    }
    const values = {
      sourceName: body.sourceName,
      employeeId: body.employeeId ?? null,
      ignored: body.ignored ?? false,
    };
    const [row] = await db
      .insert(scheduleNameMap)
      .values(values)
      .onConflictDoUpdate({
        target: scheduleNameMap.sourceName,
        set: { employeeId: values.employeeId, ignored: values.ignored },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/:sourceName', async (c) => {
    const [row] = await db
      .delete(scheduleNameMap)
      .where(eq(scheduleNameMap.sourceName, c.req.param('sourceName')!))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'mapping not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
