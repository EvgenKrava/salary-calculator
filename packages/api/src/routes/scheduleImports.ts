import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { parseScheduleGrid, type ParsedShiftCell } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { isUniqueViolation } from '../http/dbErrors';
import { locations, locationShiftSlots, scheduleNameMap, shifts } from '../schema';

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
    try {
      // exceljs's bundled .d.ts declares its own module-local `Buffer` (extends `ArrayBuffer`),
      // which no longer structurally matches @types/node's `Buffer<ArrayBufferLike>` — a stale
      // type declaration, not a runtime incompatibility. Cast to satisfy the declared signature.
      await wb.xlsx.load((await file.arrayBuffer()) as unknown as ArrayBuffer);
    } catch {
      throw new HTTPException(400, { message: 'could not read the workbook' });
    }
    const ws = wb.getWorksheet(SHEET_NAME);
    if (!ws) throw new HTTPException(400, { message: `sheet "${SHEET_NAME}" not found` });
    const grid: (string | number | null)[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row: (string | number | null)[] = [];
      for (let col = 1; col <= ws.columnCount; col++) {
        const v = ws.getCell(r, col).value;
        row.push(v === null || v === undefined ? null : (v as string | number));
      }
      grid.push(row);
    }
    return { grid, year, body };
  }

  /**
   * Turn parsed cells into concrete shifts, reporting everything that could not be
   * resolved instead of guessing. A name with no mapping, a location number with no
   * location, or a (location, slot) with no window is reported, never invented.
   */
  async function resolve(cells: ParsedShiftCell[]) {
    const [locs, slots, mappings] = await Promise.all([
      db.select().from(locations),
      db.select().from(locationShiftSlots),
      db.select().from(scheduleNameMap),
    ]);
    // Locations are matched by name, which is how the sheet refers to them (a number).
    const locationByName = new Map(locs.map((l) => [l.name.trim(), l]));
    const slotKey = (locationId: string, slot: number) => `${locationId}|${slot}`;
    const slotByKey = new Map(slots.map((s) => [slotKey(s.locationId, s.slotNumber), s]));
    const mapByName = new Map(mappings.map((m) => [m.sourceName, m]));

    const resolved: ResolvedShift[] = [];
    const unmappedNames = new Set<string>();
    const unknownLocations = new Set<number>();
    const missingSlots = new Set<string>();

    for (const cell of cells) {
      const mapping = mapByName.get(cell.sourceName);
      // An ignored mapping means the row is a placeholder, not a person — skip it
      // entirely, without reporting its location/slot as problems to fix.
      if (mapping?.ignored) continue;
      if (!mapping) unmappedNames.add(cell.sourceName);

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
    const parsed = parseScheduleGrid(grid, { year });
    const inMonth = parsed.cells.filter((cell) => cell.month === month);
    const { resolved, unmappedNames, unknownLocations, missingSlots } = await resolve(inMonth);

    let created = 0;
    let skipped = 0;
    const conflicts: string[] = [];

    for (const shift of resolved) {
      // Already imported (or otherwise present) for this employee/date/location/window.
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
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
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
      period: { year, month },
      created,
      skipped,
      conflicts,
      unmappedNames,
      unknownLocations,
      missingSlots,
    });
  });

  return routes;
}
