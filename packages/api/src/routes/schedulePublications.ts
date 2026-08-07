import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { classifyConflicts, type DayOffKind, type DayOffRequestLike } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { dayOffRequests, employees, schedulePublications, shifts } from '../schema';

/**
 * Publishing turns a month's draft shifts into the live schedule.
 *
 * A required day off BLOCKS publishing until the manager confirms with a reason, rather than
 * being forbidden outright: emergency cover on someone's day off is a real situation, and a rule
 * that cannot be overridden gets worked around outside the app where nothing records it. The
 * reason is stored with the publication.
 */

const periodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  overrideReason: z.string().trim().min(1).max(500).optional(),
});

/** First and last calendar date of a month, as the DATE strings the column holds. */
function monthBounds(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export function createSchedulePublicationRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  /** Draft shifts in the month, plus how they collide with day-off requests. */
  async function assess(year: number, month: number) {
    const { from, to } = monthBounds(year, month);
    const drafts = await db
      .select()
      .from(shifts)
      .where(
        and(eq(shifts.status, 'draft'), gte(shifts.workDate, from), lte(shifts.workDate, to)),
      );

    const requests = await db.select().from(dayOffRequests);
    const byEmployee = new Map<string, DayOffRequestLike[]>();
    for (const r of requests) {
      const list = byEmployee.get(r.employeeId) ?? [];
      list.push({ requestDate: r.requestDate, kind: r.kind as DayOffKind });
      byEmployee.set(r.employeeId, list);
    }

    const conflicts = classifyConflicts(
      drafts.map((s) => ({ employeeId: s.employeeId, workDate: s.workDate })),
      byEmployee,
    );
    return { drafts, conflicts };
  }

  /** Attach names so the publish screen can say who, not just which uuid. */
  async function withNames(list: { employeeId: string; workDate: string }[]) {
    if (list.length === 0) return [];
    const emps = await db.select().from(employees);
    const nameById = new Map(emps.map((e) => [e.id, e.name]));
    return list.map((c) => ({ ...c, employeeName: nameById.get(c.employeeId) ?? '—' }));
  }

  routes.get('/', async (c) => {
    const year = Number(c.req.query('year'));
    const month = Number(c.req.query('month'));
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      throw new HTTPException(400, { message: 'year and month are required' });
    }
    const rows = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, year), eq(schedulePublications.month, month)));
    if (rows.length === 0) return c.json({ published: false });
    return c.json({
      published: true,
      publishedAt: rows[0].publishedAt,
      publishedBy: rows[0].publishedBy,
      overrideReason: rows[0].overrideReason,
    });
  });

  routes.post('/preview', async (c) => {
    const { year, month } = await readJson(c, periodSchema);
    const { drafts, conflicts } = await assess(year, month);
    return c.json({
      draftCount: drafts.length,
      conflicts: {
        required: await withNames(conflicts.required),
        preferred: await withNames(conflicts.preferred),
      },
    });
  });

  routes.post('/', async (c) => {
    const { year, month, overrideReason } = await readJson(c, periodSchema);
    const { drafts, conflicts } = await assess(year, month);

    // Required conflicts stop the publish unless the manager states a reason. Checked before any
    // write, so a refused publish changes nothing at all.
    if (conflicts.required.length > 0 && !overrideReason) {
      throw new HTTPException(409, {
        message: `${conflicts.required.length} shift(s) fall on a required day off; a reason is needed to publish anyway`,
      });
    }

    const { from, to } = monthBounds(year, month);
    const flipped = await db
      .update(shifts)
      .set({ status: 'approved' })
      .where(and(eq(shifts.status, 'draft'), gte(shifts.workDate, from), lte(shifts.workDate, to)))
      .returning();

    // Idempotent: re-publishing a month flips any new drafts but leaves the original
    // publishedBy/publishedAt intact — the first publication is the event that mattered.
    const existing = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, year), eq(schedulePublications.month, month)));
    if (existing.length === 0) {
      await db.insert(schedulePublications).values({
        year,
        month,
        publishedBy: c.get('principal').sub,
        overrideReason: overrideReason ?? null,
      });
    }

    return c.json({
      published: flipped.length,
      conflicts: {
        required: await withNames(conflicts.required),
        preferred: await withNames(conflicts.preferred),
      },
    });
  });

  return routes;
}
