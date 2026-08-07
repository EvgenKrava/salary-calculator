import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canAdd, type DayOffKind } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { readJson } from '../http/validation';
import { currentEmployee } from '../http/employeeContext';
import { dayOffRequests, employees, schedulePublications } from '../schema';
import { loadSettings } from './appSettings';

/**
 * Days an employee asked to have off, so a manager sees the request while building the schedule
 * rather than after publishing it.
 *
 * Two write paths, deliberately: an employee records their own in their cabinet, and an admin
 * records anyone's on their card — staff with no login yet, or who tell the manager verbally.
 * That is why this is not scoped to "own records only".
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const putSchema = z.object({
  /** Omitted by an employee (they may only write their own); required for an admin. */
  employeeId: z.string().uuid().optional(),
  requestDate: dateString,
  kind: z.enum(['required', 'preferred']),
});

type RequestRow = typeof dayOffRequests.$inferSelect;
function toDto(row: RequestRow) {
  return { employeeId: row.employeeId, requestDate: row.requestDate, kind: row.kind };
}

export function createDayOffRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Which employee this call may act on.
   *
   * An employee is pinned to themselves regardless of what they send — passing someone else's id
   * is a 403 rather than a silent redirect to their own record, because silently rewriting the
   * target would make a UI bug look like it worked.
   */
  async function targetEmployeeId(c: Context<AppEnv>, requested?: string): Promise<string> {
    const principal = c.get('principal');
    const isStaff = principal.groups.some((g) => g === 'manager' || g === 'admin');
    if (isStaff) {
      if (!requested) throw new HTTPException(400, { message: 'employeeId is required' });
      const rows = await db.select().from(employees).where(eq(employees.id, requested));
      if (rows.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
      return requested;
    }
    const self = await currentEmployee(db, c);
    if (requested && requested !== self.id) {
      throw new HTTPException(403, { message: 'employees may only change their own days off' });
    }
    return self.id;
  }

  /**
   * A published month is settled: the schedule already took the preferences into account, so a
   * later change is a request to re-schedule, not a preference.
   */
  async function assertMonthOpen(date: string): Promise<void> {
    const [yearText, monthText] = date.split('-');
    const rows = await db
      .select()
      .from(schedulePublications)
      .where(
        and(
          eq(schedulePublications.year, Number(yearText)),
          eq(schedulePublications.month, Number(monthText)),
        ),
      );
    if (rows.length > 0) {
      throw new HTTPException(409, {
        message: 'the schedule for that month is already published',
      });
    }
  }

  routes.get('/', async (c) => {
    const principal = c.get('principal');
    const isStaff = principal.groups.some((g) => g === 'manager' || g === 'admin');
    // An employee always reads their own, whatever they ask for.
    const employeeId = isStaff
      ? c.req.query('employeeId')
      : (await currentEmployee(db, c)).id;

    const rows = employeeId
      ? await db.select().from(dayOffRequests).where(eq(dayOffRequests.employeeId, employeeId))
      : await db.select().from(dayOffRequests);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const filtered =
      year && month
        ? rows.filter((r) => r.requestDate.startsWith(`${year}-${String(month).padStart(2, '0')}`))
        : rows;
    return c.json(filtered.map(toDto));
  });

  routes.put('/', async (c) => {
    const body = await readJson(c, putSchema);
    const employeeId = await targetEmployeeId(c, body.employeeId);
    await assertMonthOpen(body.requestDate);

    const existing = await db
      .select()
      .from(dayOffRequests)
      .where(eq(dayOffRequests.employeeId, employeeId));

    // Changing the kind on a date already requested is an update, not a new request — so it must
    // not be counted against the limit twice. The picker cycles through kinds on one date.
    const alreadyOnThisDate = existing.find((r) => r.requestDate === body.requestDate);
    const others = existing.filter((r) => r.requestDate !== body.requestDate);

    const settings = await loadSettings(db);
    const verdict = canAdd(
      others.map((r) => ({ requestDate: r.requestDate, kind: r.kind as DayOffKind })),
      body.requestDate,
      body.kind,
      {
        required: settings.requiredDaysOffPerMonth,
        preferred: settings.preferredDaysOffPerMonth,
      },
    );
    if (!verdict.ok) {
      // A structured `code` (plus `limit`/`kind`) alongside the English `message` lets the
      // Ukrainian-language client render its own copy for this specific case while every other
      // error still falls back to showing `message` verbatim.
      return c.json(
        {
          error: `limit reached: at most ${verdict.limit} ${verdict.kind} days off per month`,
          code: 'limit_reached',
          limit: verdict.limit,
          kind: verdict.kind,
        },
        409,
      );
    }

    const createdBy = c.get('principal').sub;
    if (alreadyOnThisDate) {
      const [row] = await db
        .update(dayOffRequests)
        .set({ kind: body.kind, createdBy })
        .where(eq(dayOffRequests.id, alreadyOnThisDate.id))
        .returning();
      return c.json(toDto(row), 201);
    }
    const [row] = await db
      .insert(dayOffRequests)
      .values({ employeeId, requestDate: body.requestDate, kind: body.kind, createdBy })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.delete('/', async (c) => {
    const date = c.req.query('date');
    if (!date || !dateString.safeParse(date).success) {
      throw new HTTPException(400, { message: 'date must be YYYY-MM-DD' });
    }
    const employeeId = await targetEmployeeId(c, c.req.query('employeeId'));
    await assertMonthOpen(date);
    const [row] = await db
      .delete(dayOffRequests)
      .where(and(eq(dayOffRequests.employeeId, employeeId), eq(dayOffRequests.requestDate, date)))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'day off request not found' });
    return c.json({ deleted: true });
  });

  return routes;
}
