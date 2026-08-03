import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { employees, levels } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  levelId: z.string().uuid(),
  revenuePercent: z.number().min(0).max(1).default(0),
  cognitoSub: z.string().min(1).nullish(),
  active: z.boolean().default(true),
});
const updateSchema = z
  .object({
    name: z.string().min(1),
    levelId: z.string().uuid(),
    revenuePercent: z.number().min(0).max(1),
    cognitoSub: z.string().min(1).nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type EmployeeRow = typeof employees.$inferSelect;
function toDto(row: EmployeeRow) {
  return {
    id: row.id,
    name: row.name,
    levelId: row.levelId,
    revenuePercent: Number(row.revenuePercent),
    cognitoSub: row.cognitoSub,
    active: row.active,
  };
}

export function createEmployeeRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  // A well-formed but non-existent levelId would otherwise hit the FK and leak a 500.
  async function requireLevel(levelId: string): Promise<void> {
    const rows = await db.select().from(levels).where(eq(levels.id, levelId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown levelId' });
  }

  routes.get('/', async (c) => {
    const rows = await db.select().from(employees);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const rows = await db.select().from(employees).where(eq(employees.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'employee not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    await requireLevel(body.levelId);
    if (body.cognitoSub) {
      const dupe = await db.select().from(employees).where(eq(employees.cognitoSub, body.cognitoSub));
      if (dupe.length > 0) throw new HTTPException(409, { message: 'cognitoSub already linked' });
    }
    const [row] = await db
      .insert(employees)
      .values({
        name: body.name,
        levelId: body.levelId,
        revenuePercent: String(body.revenuePercent),
        cognitoSub: body.cognitoSub ?? null,
        active: body.active,
      })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, updateSchema);
    if (body.cognitoSub) {
      const dupe = await db
        .select()
        .from(employees)
        .where(and(eq(employees.cognitoSub, body.cognitoSub), ne(employees.id, id)));
      if (dupe.length > 0) throw new HTTPException(409, { message: 'cognitoSub already linked' });
    }
    if (body.levelId !== undefined) await requireLevel(body.levelId);
    const patch: Partial<typeof employees.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.levelId !== undefined) patch.levelId = body.levelId;
    if (body.revenuePercent !== undefined) patch.revenuePercent = String(body.revenuePercent);
    if (body.cognitoSub !== undefined) patch.cognitoSub = body.cognitoSub;
    if (body.active !== undefined) patch.active = body.active;
    const [row] = await db.update(employees).set(patch).where(eq(employees.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'employee not found' });
    return c.json(toDto(row));
  });

  return routes;
}