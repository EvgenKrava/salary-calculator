import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { calculateSalaries, payPeriodsForMonth, type CalcInput } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { isUniqueViolation } from '../http/dbErrors';
import { currentEmployee } from '../http/employeeContext';
import { employees, levels, locations, shifts, dailyRevenue, salaryRuns, salaryRunLines } from '../schema';

const createSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  half: z.union([z.literal(1), z.literal(2)]),
  bonuses: z.record(z.string(), z.number()).optional(),
});

type RunRow = typeof salaryRuns.$inferSelect;
function runDto(row: RunRow) {
  return { id: row.id, periodStart: row.periodStart, periodEnd: row.periodEnd, createdAt: row.createdAt };
}
type LineRow = typeof salaryRunLines.$inferSelect;
function lineDto(row: LineRow) {
  return {
    employeeId: row.employeeId,
    hourlyPay: Number(row.hourlyPay),
    revenueShare: Number(row.revenueShare),
    bonus: Number(row.bonus),
    total: Number(row.total),
  };
}

export function createSalaryRunRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const rows = await db
      .select({
        runId: salaryRunLines.runId,
        periodStart: salaryRuns.periodStart,
        periodEnd: salaryRuns.periodEnd,
        hourlyPay: salaryRunLines.hourlyPay,
        revenueShare: salaryRunLines.revenueShare,
        bonus: salaryRunLines.bonus,
        total: salaryRunLines.total,
      })
      .from(salaryRunLines)
      .innerJoin(salaryRuns, eq(salaryRunLines.runId, salaryRuns.id))
      .where(eq(salaryRunLines.employeeId, employee.id));
    return c.json(
      rows.map((r) => ({
        runId: r.runId,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        hourlyPay: Number(r.hourlyPay),
        revenueShare: Number(r.revenueShare),
        bonus: Number(r.bonus),
        total: Number(r.total),
      })),
    );
  });

  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!id || !z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'run not found' });
    return id;
  }

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const [first, second] = payPeriodsForMonth(body.year, body.month);
    const period = body.half === 1 ? first : second;

    const [emps, lvls, locs, shfts, revs] = await Promise.all([
      db.select().from(employees),
      db.select().from(levels),
      db.select().from(locations),
      db
        .select()
        .from(shifts)
        .where(and(eq(shifts.status, 'approved'), gte(shifts.workDate, period.start), lte(shifts.workDate, period.end))),
      db.select().from(dailyRevenue).where(eq(dailyRevenue.status, 'approved')),
    ]);

    const input: CalcInput = {
      employees: emps.map((e) => ({
        id: e.id,
        name: e.name,
        levelId: e.levelId,
        revenuePercent: Number(e.revenuePercent),
        cognitoSub: e.cognitoSub,
        active: e.active,
      })),
      levels: lvls.map((l) => ({ id: l.id, name: l.name, ratePerHour: Number(l.ratePerHour) })),
      locations: locs.map((l) => ({ id: l.id, name: l.name, standardShiftHours: Number(l.standardShiftHours) })),
      shifts: shfts.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        locationId: s.locationId,
        workDate: s.workDate,
        status: s.status,
        source: s.source,
      })),
      dailyRevenue: revs.map((r) => ({
        locationId: r.locationId,
        revenueDate: r.revenueDate,
        amount: Number(r.amount),
        status: r.status,
      })),
      bonuses: body.bonuses ?? {},
    };

    const result = calculateSalaries(input, period);
    if (result.blocked) {
      return c.json({ error: 'revenue data incomplete for the period', gaps: result.gaps }, 409);
    }

    try {
      const run = await db.transaction(async (tx) => {
        const [runRow] = await tx
          .insert(salaryRuns)
          .values({ periodStart: period.start, periodEnd: period.end, createdBy: c.get('principal').sub })
          .returning();
        if (result.lines.length > 0) {
          await tx.insert(salaryRunLines).values(
            result.lines.map((l) => ({
              runId: runRow.id,
              employeeId: l.employeeId,
              hourlyPay: String(l.hourlyPay),
              revenueShare: String(l.revenueShare),
              bonus: String(l.bonus),
              total: String(l.total),
            })),
          );
        }
        return runRow;
      });
      return c.json({ ...runDto(run), lines: result.lines }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: 'a salary run already exists for this period' });
      throw err;
    }
  });

  routes.get('/', async (c) => {
    const rows = await db.select().from(salaryRuns);
    return c.json(rows.map(runDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const runs = await db.select().from(salaryRuns).where(eq(salaryRuns.id, id));
    const run = getOr404(runs, 'run not found');
    const lines = await db.select().from(salaryRunLines).where(eq(salaryRunLines.runId, id));
    return c.json({ ...runDto(run), lines: lines.map(lineDto) });
  });

  return routes;
}