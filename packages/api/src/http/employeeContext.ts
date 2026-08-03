import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { employees } from '../schema';

export type EmployeeRow = typeof employees.$inferSelect;

/** Resolve the authenticated caller to their employee row via cognito_sub. */
export async function currentEmployee(db: Db, c: Context<AppEnv>): Promise<EmployeeRow> {
  const principal = c.get('principal');
  const rows = await db
    .select()
    .from(employees)
    .where(and(eq(employees.cognitoSub, principal.sub), eq(employees.active, true)));
  if (rows.length === 0) {
    throw new HTTPException(403, { message: 'no employee profile linked to this account' });
  }
  return rows[0];
}