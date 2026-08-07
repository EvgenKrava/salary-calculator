import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { parseScheduleGrid, type ParsedShiftCell, toSqlTime } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { isUniqueViolation } from '../http/dbErrors';
import { gridFromWorksheet } from '../http/excelGrid';
import { locations, locationShiftSlots, scheduleNameMap, shifts, employees } from '../schema';

const SHEET_NAME = 'Графік роботи';

interface ResolvedShift {
  employeeId: string;
  locationId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  sourceName: string;
  slot: number;
  locationNumber: number;
}

export function createScheduleImportRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  /** Read the uploaded workbook's schedule sheet into the parser's row-major grid. */
  async function gridFromUpload(c: Context<AppEnv>) {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'file is required' });
    const year = Number(String(body['year'] ?? ''));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new HTTPException(400, { message: 'year must be an integer between 2000 and 2100' });
    }
    const wb = new ExcelJS.Workbook();
    let grid: (string | number | null)[][];
    try {
      // exceljs's bundled .d.ts declares its own module-local `Buffer` (extends `ArrayBuffer`),
      // which no longer structurally matches @types/node's `Buffer<ArrayBufferLike>` — a stale
      // type declaration, not a runtime incompatibility. Cast to satisfy the declared signature.
      await wb.xlsx.load((await file.arrayBuffer()) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SHEET_NAME);
      if (!ws) throw new HTTPException(400, { message: `sheet "${SHEET_NAME}" not found` });
      // gridFromWorksheet/flattenCell walk every cell in the workbook and can throw on a
      // malformed cell (e.g. an unparseable Date) — that must become a 400, not an opaque
      // 500, so it stays inside this try/catch alongside the load itself.
      grid = gridFromWorksheet(ws);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      throw new HTTPException(400, { message: 'could not read the schedule sheet' });
    }
    return { grid, year, body };
  }

  /**
   * Turn parsed cells into concrete shifts, reporting everything that could not be
   * resolved instead of guessing. A name with no mapping, a location number with no
   * location, a (location, slot) with no window, or a mapping that points at a
   * deactivated employee is reported, never invented.
   */
  async function resolve(cells: ParsedShiftCell[]) {
    const [locs, slots, mappings, emps] = await Promise.all([
      db.select().from(locations),
      db.select().from(locationShiftSlots),
      db.select().from(scheduleNameMap),
      db.select().from(employees),
    ]);
    // Locations are matched by name, which is how the sheet refers to them (a number).
    const locationByName = new Map(locs.map((l) => [l.name.trim(), l]));
    const slotKey = (locationId: string, slot: number) => `${locationId}|${slot}`;
    const slotByKey = new Map(slots.map((s) => [slotKey(s.locationId, s.slotNumber), s]));
    const mapByName = new Map(mappings.map((m) => [m.sourceName, m]));
    const employeeById = new Map(emps.map((e) => [e.id, e]));

    const resolved: ResolvedShift[] = [];
    const unmappedNames = new Set<string>();
    const unknownLocations = new Set<number>();
    const missingSlots = new Set<string>();
    const inactiveEmployees = new Set<string>();

    for (const cell of cells) {
      const mapping = mapByName.get(cell.sourceName);
      // An ignored mapping means the row is a placeholder, not a person — skip it
      // entirely, without reporting its location/slot as problems to fix.
      if (mapping?.ignored) continue;
      if (!mapping) unmappedNames.add(cell.sourceName);

      // `calculateSalaries` skips inactive employees for payment but still counts their
      // shifts in the pass-1 proration denominator — importing shifts for a departed
      // employee would silently dilute every active coworker's revenue share on those
      // location-days. Report it instead of resolving to a shift. This flag is recorded
      // rather than acted on immediately (via `continue`) so a cell that is BOTH an
      // inactive-employee mapping AND has an unknown location/missing slot still surfaces
      // that second problem too — unlike the deliberate `ignored` case above, an inactive
      // employee's bad location/slot is still a real data problem worth reporting.
      let isInactiveEmployee = false;
      if (mapping?.employeeId) {
        const employee = employeeById.get(mapping.employeeId);
        if (employee && !employee.active) {
          inactiveEmployees.add(cell.sourceName);
          isInactiveEmployee = true;
        }
      }

      // Location/slot resolution is checked independently of the name mapping so an
      // unmapped name and an unknown location on the same cell are both reported,
      // rather than the first check short-circuiting the second.
      const location = locationByName.get(String(cell.locationNumber));
      if (!location) {
        unknownLocations.add(cell.locationNumber);
        continue;
      }
      const slot = slotByKey.get(slotKey(location.id, cell.slot));
      if (!slot) {
        missingSlots.add(`${location.name}:${cell.slot}`);
        continue;
      }
      if (isInactiveEmployee) continue;
      if (!mapping || mapping.employeeId === null) continue;

      resolved.push({
        employeeId: mapping.employeeId,
        locationId: location.id,
        workDate: cell.date,
        startsAt: slot.startsAt.slice(0, 5),
        endsAt: slot.endsAt.slice(0, 5),
        sourceName: cell.sourceName,
        slot: cell.slot,
        locationNumber: cell.locationNumber,
      });
    }

    return {
      resolved,
      unmappedNames: [...unmappedNames],
      unknownLocations: [...unknownLocations],
      missingSlots: [...missingSlots],
      inactiveEmployees: [...inactiveEmployees],
    };
  }

  /**
   * A person cannot be in two places at once: reject an imported window that overlaps an
   * existing approved shift for that employee on that date, at ANY location. Half-open, so
   * touching windows (08:00-14:00 then 14:00-20:00) are fine.
   */
  async function overlapsApproved(
    employeeId: string,
    workDate: string,
    startsAt: string,
    endsAt: string,
  ): Promise<boolean> {
    const sameDay = await db
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.employeeId, employeeId),
          eq(shifts.workDate, workDate),
          // 'approved' only: a draft is a schedule still being built and must not report a
          // phantom conflict against a real shift.
          eq(shifts.status, 'approved'),
        ),
      );
    return sameDay.some(
      (s) => startsAt < s.endsAt.slice(0, 5) && s.startsAt.slice(0, 5) < endsAt,
    );
  }

  routes.post('/preview', async (c) => {
    const { grid, year } = await gridFromUpload(c);
    const parsed = parseScheduleGrid(grid, { year });
    const resolution = await resolve(parsed.cells);
    return c.json({
      months: parsed.months,
      sourceNames: parsed.sourceNames,
      anomalies: parsed.anomalies,
      ...resolution,
    });
  });

  routes.post('/commit', async (c) => {
    const { grid, year, body } = await gridFromUpload(c);
    const month = Number(String(body['month'] ?? ''));
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new HTTPException(400, { message: 'month must be an integer between 1 and 12' });
    }
    /*
     * The period to import is (targetYear, month) — NOT (year, month).
     *
     * `year` is the year the sheet's timeline *starts* in, which the parser needs in order to date
     * the first month block. The period the manager is committing is a separate thing: the real
     * client sheet is one continuous timeline running Травень 2026 → Серпень 2027, so a workbook
     * loaded with year=2026 legitimately contains January **2027**.
     *
     * Filtering on month alone was correct only while a workbook covered a single calendar year.
     * Here `month === 5` matched May 2026 *and* May 2027: importing May selected 415 cells across
     * both years instead of 191, and the same person on the same day-of-month in two different
     * years was then reported to the manager as an overlapping-shift conflict — the error that
     * surfaced on the real file.
     *
     * `targetYear` defaults to `year` so an existing single-year caller is unaffected.
     */
    const targetYearRaw = String(body['targetYear'] ?? '').trim();
    const targetYear = targetYearRaw === '' ? year : Number(targetYearRaw);
    if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
      throw new HTTPException(400, {
        message: 'targetYear must be an integer between 2000 and 2100',
      });
    }

    const parsed = parseScheduleGrid(grid, { year });
    // `cell.year` is the parser's rolled-over year (scheduleParser → yearOffsetByColumn).
    const inMonth = parsed.cells.filter(
      (cell) => cell.month === month && cell.year === targetYear,
    );
    const { resolved, unmappedNames, unknownLocations, missingSlots, inactiveEmployees } =
      await resolve(inMonth);

    let created = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    const windowChanged: string[] = [];

    for (const shift of resolved) {
      // Already imported (or otherwise present) for this employee/date/location, matched
      // on the same key the DB's unique constraint uses (employeeId+workDate+locationId+
      // startsAt). A match on those four fields alone is not enough: if an admin later
      // narrows the slot window and the manager re-imports, the stale row still matches on
      // startsAt and would be silently counted `skipped`, leaving the OLD (longer) window in
      // place — overpaying that employee and diluting coworkers' revenue share. So `endsAt`
      // is checked too: only an exact match on all five fields counts as `skipped`; a
      // startsAt match with a different endsAt is reported in `windowChanged` instead.
      const existing = await db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.employeeId, shift.employeeId),
            eq(shifts.workDate, shift.workDate),
            eq(shifts.locationId, shift.locationId),
            eq(shifts.startsAt, shift.startsAt),
          ),
        );
      if (existing.length > 0) {
        const stale = existing.find((row) => row.endsAt.slice(0, 5) !== shift.endsAt);
        if (stale) {
          windowChanged.push(
            `${shift.sourceName} ${shift.workDate} slot ${shift.slot}: existing window ` +
              `${stale.startsAt.slice(0, 5)}-${stale.endsAt.slice(0, 5)} vs resolved ` +
              `${shift.startsAt}-${shift.endsAt}`,
          );
          continue;
        }
        skipped += 1;
        continue;
      }
      if (await overlapsApproved(shift.employeeId, shift.workDate, shift.startsAt, shift.endsAt)) {
        conflicts.push(
          `${shift.sourceName} ${shift.workDate} slot ${shift.slot}: overlaps an approved shift`,
        );
        continue;
      }
      try {
        await db.insert(shifts).values({
          employeeId: shift.employeeId,
          locationId: shift.locationId,
          workDate: shift.workDate,
          // A Postgres TIME column needs HH:MM:SS — the Data API rejects HH:MM.
          startsAt: toSqlTime(shift.startsAt),
          endsAt: toSqlTime(shift.endsAt),
          status: 'approved',
          source: 'imported',
        });
        created += 1;
      } catch (err) {
        if (isUniqueViolation(err)) {
          skipped += 1;
          continue;
        }
        conflicts.push(`${shift.sourceName} ${shift.workDate} slot ${shift.slot}`);
      }
    }

    return c.json({
      // The period actually committed, so the UI cannot report "May 2026" for a May 2027 import.
      period: { year: targetYear, month },
      created,
      skipped,
      conflicts,
      windowChanged,
      unmappedNames,
      unknownLocations,
      missingSlots,
      inactiveEmployees,
    });
  });

  return routes;
}
