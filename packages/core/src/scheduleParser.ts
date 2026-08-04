export interface ParsedShiftCell {
  sourceName: string;
  slot: number;
  year: number;
  month: number;
  day: number;
  /** 'YYYY-MM-DD' */
  date: string;
  locationNumber: number;
}

export interface ParsedAnomaly {
  kind: 'substitute' | 'annotation' | 'unparsed';
  sourceName: string | null;
  slot: number;
  date: string | null;
  raw: string;
}

export interface ParseResult {
  cells: ParsedShiftCell[];
  anomalies: ParsedAnomaly[];
  sourceNames: string[];
  months: { year: number; month: number }[];
}

/** Ukrainian month names as they appear in the sheet's block headers. */
const MONTHS: Record<string, number> = {
  січень: 1, лютий: 2, березень: 3, квітень: 4, травень: 5, червень: 6,
  липень: 7, серпень: 8, вересень: 9, жовтень: 10, листопад: 11, грудень: 12,
};

const WEEKDAYS = new Set(['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд']);

function monthFromHeader(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  return MONTHS[value.trim().toLowerCase()] ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function asNumber(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** A row is a name row if its name cell holds text that is not a month or slot marker. */
function nameFromRow(value: string | number | null): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name === '') return null;
  if (monthFromHeader(name) !== null) return null;
  if (name.toLowerCase().startsWith('зміни')) return null;
  return name;
}

const NAME_COL = 2; // 0-based: spreadsheet column 3

/**
 * Parse the schedule grid into dated shift cells.
 *
 * Layout (verified against the real workbook, design spec §5.1): months run horizontally;
 * each vertical block is a shift slot; a block starts with a month-name header row, then a
 * weekday row, then a day-of-month row, then employee name rows whose cell values are
 * location numbers. Anything non-numeric in a day cell (substitute names) and any text row
 * without a name (meeting/inventory annotations) is reported as an anomaly rather than
 * silently dropped.
 */
export function parseScheduleGrid(
  grid: (string | number | null)[][],
  opts: { year: number },
): ParseResult {
  const cells: ParsedShiftCell[] = [];
  const anomalies: ParsedAnomaly[] = [];
  const sourceNames = new Set<string>();
  const months: { year: number; month: number }[] = [];
  const seenMonths = new Set<number>();

  let slot = 0;

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];

    // A block header row carries one or more month names; the day numbers live two rows
    // below it, and each month's day columns are contiguous from its header column.
    const monthCols: { month: number; startCol: number }[] = [];
    for (let c = 0; c < row.length; c++) {
      const month = monthFromHeader(row[c]);
      if (month !== null) monthCols.push({ month, startCol: c });
    }
    if (monthCols.length === 0) continue;

    slot += 1;
    const weekdayRow = grid[r + 1] ?? [];
    const dayRow = grid[r + 2] ?? [];

    // Day columns are those whose weekday label is a known abbreviation AND whose day-row
    // value is a number. This excludes the trailing shift-count total column, which has a
    // number but no weekday label above it.
    const dayCols: { col: number; day: number; month: number }[] = [];
    for (let c = 0; c < Math.max(weekdayRow.length, dayRow.length); c++) {
      const weekday = typeof weekdayRow[c] === 'string' ? String(weekdayRow[c]).trim().toLowerCase() : '';
      if (!WEEKDAYS.has(weekday)) continue;
      const day = asNumber((dayRow[c] ?? '') as string | number);
      if (day === null || day < 1 || day > 31) continue;
      // Attribute the column to the right-most month header at or before it.
      let month = monthCols[0].month;
      for (const mc of monthCols) if (c >= mc.startCol) month = mc.month;
      dayCols.push({ col: c, day, month });
    }

    for (const mc of monthCols) {
      if (!seenMonths.has(mc.month)) {
        seenMonths.add(mc.month);
        months.push({ year: opts.year, month: mc.month });
      }
    }

    // Employee rows run until the next block header (or the end of the grid).
    for (let rr = r + 3; rr < grid.length; rr++) {
      const bodyRow = grid[rr] ?? [];
      if (bodyRow.some((v) => monthFromHeader(v) !== null)) break;

      const rawNameCell = bodyRow[NAME_COL] ?? null;
      const nameCellBlank =
        rawNameCell === null || (typeof rawNameCell === 'string' && rawNameCell.trim() === '');
      const name = nameFromRow(rawNameCell);

      for (const dc of dayCols) {
        const raw = bodyRow[dc.col];
        if (raw === null || raw === undefined || String(raw).trim() === '') continue;
        const date = `${opts.year}-${pad(dc.month)}-${pad(dc.day)}`;

        if (name === null) {
          if (nameCellBlank) {
            // Text on a row with no name at all is a schedule annotation (meeting, inventory...).
            anomalies.push({ kind: 'annotation', sourceName: null, slot, date, raw: String(raw) });
          } else {
            // The name cell held slot-context text (e.g. a shift-count marker) that was
            // filtered out as a non-person row, but the day cell still holds a covering
            // substitute's abbreviated name.
            anomalies.push({ kind: 'substitute', sourceName: null, slot, date, raw: String(raw) });
          }
          continue;
        }

        const locationNumber = asNumber(raw as string | number);
        if (locationNumber === null) {
          // A name instead of a number means someone covered the shift.
          anomalies.push({ kind: 'substitute', sourceName: name, slot, date, raw: String(raw) });
          continue;
        }
        cells.push({
          sourceName: name,
          slot,
          year: opts.year,
          month: dc.month,
          day: dc.day,
          date,
          locationNumber,
        });
      }

      if (name !== null) sourceNames.add(name);
    }
  }

  return { cells, anomalies, sourceNames: [...sourceNames], months };
}
