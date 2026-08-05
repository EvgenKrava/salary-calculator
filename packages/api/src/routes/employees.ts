import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { LoginExistsError, type IdentityProvider } from '../auth/identityProvider';
import { readJson, getOr404 } from '../http/validation';
import { employees, levels } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  levelId: z.string().uuid(),
  revenuePercent: z.number().min(0).max(1).default(0),
  cognitoSub: z.string().min(1).nullish(),
  active: z.boolean().default(true),
});
/** The three Cognito groups. Must match the group names Terraform creates in cognito.tf. */
const ROLES = ['admin', 'manager', 'employee'] as const;

const inviteSchema = z.object({
  // Trim and lowercase BEFORE validating. Zod's .email() rejects " a@b.com " for the
  // whitespace, so validating first turns a pasted-with-a-space address — the most likely way
  // a manager types this — into an opaque 400. Lowercasing here also makes the stored value
  // canonical: the pool uses email as the username, so Olena@x.com and olena@x.com must not
  // become two logins.
  email: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.string().email()),
  // No default: which role someone gets decides what payroll data they can see, so it is
  // always an explicit choice by the manager rather than an implicit "employee".
  role: z.enum(ROLES),
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

export function createEmployeeRoutes(db: Db, identity?: IdentityProvider): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  /**
   * The identity provider is optional so the API still boots (and every non-invite test still
   * runs) without Cognito configured. Routes that need it fail with a clear 503 rather than a
   * TypeError on undefined.
   */
  function requireIdentity(): IdentityProvider {
    if (!identity) {
      throw new HTTPException(503, {
        message: 'login management is not configured on this deployment',
      });
    }
    return identity;
  }

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

  /**
   * Invite an employee: create their Cognito login, put them in a role group, and link the
   * `sub` to their employee row — one manager action instead of two AWS CLI calls plus a
   * copied UUID. Cognito emails a temporary password and the SPA's existing
   * `newPasswordRequired` flow handles first sign-in.
   *
   * Ordering is deliberate. The login is created FIRST, then the DB row, and the login is
   * deleted if the DB write fails. The alternative (row first) can leave an employee row
   * pointing at a login that was never created, which is invisible in the UI — whereas this
   * ordering's worst case is a rolled-back invite the manager can simply retry.
   */
  routes.post('/:id/invite', async (c) => {
    const idp = requireIdentity();
    const id = c.req.param('id');
    const body = await readJson(c, inviteSchema);

    const [employee] = await db.select().from(employees).where(eq(employees.id, id));
    if (!employee) throw new HTTPException(404, { message: 'employee not found' });
    if (employee.cognitoSub) {
      throw new HTTPException(409, { message: 'employee already has a login' });
    }
    if (!employee.active) {
      // Inviting someone who has been deactivated is almost certainly a mistake, and it would
      // create a login that can sign in but sees nothing.
      throw new HTTPException(409, { message: 'cannot invite an inactive employee' });
    }

    const email = body.email;
    let sub: string;
    try {
      ({ sub } = await idp.createUser({ email, group: body.role }));
    } catch (err) {
      if (err instanceof LoginExistsError) {
        throw new HTTPException(409, { message: err.message });
      }
      throw err;
    }

    // Validate at the boundary, not only inside the Cognito implementation. Writing a blank
    // cognito_sub would link the employee to nothing while reporting success — and because the
    // column is UNIQUE, the FIRST blank would then block every later invite with an opaque
    // constraint violation.
    if (!sub.trim()) {
      throw new HTTPException(502, {
        message: 'the identity provider did not return a user id; no login was linked',
      });
    }

    try {
      const [row] = await db
        .update(employees)
        .set({ cognitoSub: sub })
        // Re-check cognito_sub in the UPDATE: two managers inviting the same employee
        // concurrently would otherwise both create a login and the second would overwrite the
        // first's link, orphaning it.
        .where(and(eq(employees.id, id), isNull(employees.cognitoSub)))
        .returning();
      if (!row) throw new HTTPException(409, { message: 'employee already has a login' });
      return c.json({ ...toDto(row), email }, 201);
    } catch (err) {
      // Roll the login back so a retry is not blocked by a half-created account.
      try {
        await idp.deleteUser(sub);
      } catch (cleanupErr) {
        // Log and surface the original failure; a leaked login is recoverable by hand, but
        // masking the real error is not.
        console.error('failed to roll back Cognito user after invite failure', { sub, cleanupErr });
      }
      throw err;
    }
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

    /**
     * Keep the login's enabled state in step with `active`.
     *
     * Without this, "deactivating" an employee only removes them from payroll — their login
     * still works and `/api/shifts/me` and `/api/salary-runs/me` still serve their data,
     * because those endpoints key off the verified JWT `sub`. Someone who has left the
     * business would keep read access to their own records indefinitely.
     *
     * Disable, never delete: the employee row and its salary history must survive, and a
     * disabled user can be re-enabled if the deactivation was a mistake.
     *
     * Deliberately best-effort. The payroll change is already committed and is the
     * authoritative record; failing the whole request here would leave the manager unable to
     * deactivate anyone while Cognito is unavailable. Logged loudly instead.
     */
    if (body.active !== undefined && row.cognitoSub && identity) {
      try {
        if (row.active) await identity.enableUser(row.cognitoSub);
        else await identity.disableUser(row.cognitoSub);
      } catch (err) {
        console.error('failed to sync login enabled state', {
          employeeId: row.id,
          active: row.active,
          err,
        });
      }
    }

    return c.json(toDto(row));
  });

  return routes;
}