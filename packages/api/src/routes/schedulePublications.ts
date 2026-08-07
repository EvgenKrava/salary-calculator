import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  classifyConflicts,
  findOverlaps,
  type DayOffKind,
  type DayOffRequestLike,
} from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { isUniqueViolation } from '../http/dbErrors';
import {
  dayOffRequests,
  employees,
  schedulePublicationOverrides,
  schedulePublications,
  shifts,
} from '../schema';

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

    /*
     * Employee-days where flipping these drafts would leave one person working two overlapping
     * windows — i.e. paid twice for the same hours.
     *
     * Checked here rather than only on write because `assertNoOverlap` on assign is
     * 'approved'-only by design (a draft must not report a phantom conflict against a real shift),
     * so two drafts in the same window pass every check on the way in. The flip is the moment they
     * become payable, which makes it the last place to catch them. Compared against already-
     * approved shifts in the month as well as against each other.
     */
    const approved = await db
      .select()
      .from(shifts)
      .where(
        and(eq(shifts.status, 'approved'), gte(shifts.workDate, from), lte(shifts.workDate, to)),
      );
    const overlaps = findOverlaps(drafts, approved);

    return { drafts, conflicts, overlaps };
  }

  /** Attach names so the publish screen can say who, not just which uuid. */
  async function withNames(list: { employeeId: string; workDate: string }[]) {
    if (list.length === 0) return [];
    const emps = await db.select().from(employees);
    const nameById = new Map(emps.map((e) => [e.id, e.name]));
    return list.map((c) => ({ ...c, employeeName: nameById.get(c.employeeId) ?? '—' }));
  }

  /** Every override on record for the month, newest first, for the publish screen's history view. */
  async function overrideHistory(year: number, month: number) {
    const rows = await db
      .select()
      .from(schedulePublicationOverrides)
      .where(
        and(
          eq(schedulePublicationOverrides.year, year),
          eq(schedulePublicationOverrides.month, month),
        ),
      )
      .orderBy(desc(schedulePublicationOverrides.createdAt));
    return rows.map((r) => ({ reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt }));
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
    const overrides = await overrideHistory(year, month);
    if (rows.length === 0) return c.json({ published: false, overrides });
    return c.json({
      published: true,
      publishedAt: rows[0].publishedAt,
      publishedBy: rows[0].publishedBy,
      overrideReason: rows[0].overrideReason,
      overrides,
    });
  });

  routes.post('/preview', async (c) => {
    const { year, month } = await readJson(c, periodSchema);
    const { drafts, conflicts, overlaps } = await assess(year, month);
    return c.json({
      draftCount: drafts.length,
      conflicts: {
        required: await withNames(conflicts.required),
        preferred: await withNames(conflicts.preferred),
      },
      // Preview never writes, so it reports the blocker rather than refusing — the manager sees
      // it before pressing publish instead of hitting a 409.
      overlaps: await withNames(overlaps),
    });
  });

  routes.post('/', async (c) => {
    const { year, month, overrideReason } = await readJson(c, periodSchema);
    const { drafts, conflicts, overlaps } = await assess(year, month);

    /*
     * An overlap is a hard refusal — no override, unlike a required day off.
     *
     * A day-off conflict is a judgement call a manager may legitimately make (emergency cover is
     * real). Paying someone twice for the same hours is not a judgement call, so `overrideReason`
     * must not unlock it. Checked before any write, so a refused publish changes nothing.
     */
    if (overlaps.length > 0) {
      /*
       * Returned directly rather than thrown as an HTTPException: `app.onError` renders only
       * `{ error: message }`, which would drop the `overlaps` list. Same shape and reasoning as
       * the day-off limit 409 — a structured body the Ukrainian client can render as its own copy,
       * naming the days to fix instead of a count the manager has to go hunting for.
       */
      return c.json(
        {
          error: `${overlaps.length} employee-day(s) would have two overlapping shifts; fix the schedule before publishing`,
          code: 'publish_overlaps',
          overlaps: await withNames(overlaps),
        },
        409,
      );
    }

    // Required conflicts stop the publish unless the manager states a reason. Checked before any
    // write, so a refused publish changes nothing at all.
    if (conflicts.required.length > 0 && !overrideReason) {
      throw new HTTPException(409, {
        message: `${conflicts.required.length} shift(s) fall on a required day off; a reason is needed to publish anyway`,
      });
    }

    const { from, to } = monthBounds(year, month);
    const principal = c.get('principal').sub;

    /** Flip this month's remaining drafts. Idempotent: a second run matches nothing new. */
    async function flip(dbOrTx: Db) {
      return dbOrTx
        .update(shifts)
        .set({ status: 'approved' })
        .where(
          and(eq(shifts.status, 'draft'), gte(shifts.workDate, from), lte(shifts.workDate, to)),
        )
        .returning();
    }

    /**
     * Append this call's override to the history — including the first publish, per Finding 3's
     * "every time someone was scheduled on a required day off, and why". Skipped when there is
     * no reason to record (no conflict was overridden).
     */
    async function recordOverride(dbOrTx: Db) {
      if (!overrideReason) return;
      await dbOrTx
        .insert(schedulePublicationOverrides)
        .values({ year, month, reason: overrideReason, createdBy: principal });
    }

    let flipped: Awaited<ReturnType<typeof flip>>;
    try {
      // Flip and the FIRST publication row commit together (Finding 2): if the insert below
      // throws, the flip must not have happened either, or shifts would be live and payable
      // with no record of who published them.
      flipped = await db.transaction(async (tx) => {
        const f = await flip(tx as unknown as Db);
        // Always attempted, never pre-checked with a separate SELECT: a `year, month` row
        // already existing (an earlier publish, or a concurrent request that committed first)
        // surfaces here as a real unique-violation rather than a race window between "check"
        // and "insert" (Finding 1).
        await tx.insert(schedulePublications).values({
          year,
          month,
          publishedBy: principal,
          overrideReason: overrideReason ?? null,
        });
        await recordOverride(tx as unknown as Db);
        return f;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The transaction above rolled back in FULL, including its own flip attempt — Postgres
      // aborts the whole transaction on a constraint violation, so nothing from it was
      // committed. That is exactly why this catch sits OUTSIDE db.transaction rather than
      // around the single insert inside it: catching inside would still lose the flip to the
      // same rollback, and mask it. Out here, the database is known-clean, so it's safe to
      // redo the flip as its own atomic unit and treat the whole request as the idempotent
      // success it is — the month IS published, whether by an earlier call or by whoever won
      // this race, and that satisfies the caller's intent. A 409 would be wrong: nothing the
      // caller did was rejected.
      flipped = await db.transaction(async (tx) => {
        const f = await flip(tx as unknown as Db);
        await recordOverride(tx as unknown as Db);
        return f;
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
