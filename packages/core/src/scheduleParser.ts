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

/**
 * Total: never throws regardless of what reaches it. `value` is typed `unknown` (not
 * `string | number`) so the parser cannot be made to crash by a caller that fails to
 * flatten its cell values before handing them over — a formatted cell (rich text, a
 * formula result, a Date, a boolean) must fall through to `null`, not reach `.trim()`.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * The real length of `month` in `year`, for validating a day-of-month cell. A block
 * copy-pasted from a 31-day month into a 30-day (or 28/29-day) month leaves a stale
 * day-31 (or day-30) column; the day-of-month row still says "31", but no such date
 * exists. `Date.UTC(year, month, 0)` is the last day of the PRECEDING month index, i.e.
 * the last day of `month` (1-based) itself.
 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A row is a name row if its name cell holds non-blank content that is not a month or
 * slot marker. `value` is `unknown` so a caller that hands over an unflattened cell
 * (rich text, a number, anything) still gets a coerced, non-null name back rather than
 * `null` — the previous `typeof value !== 'string'` guard turned a formatted name cell
 * into `null` while the cell was plainly non-blank, and every location number on that
 * row was then filed as a nameless `substitute` anomaly, silently dropping the person
 * from `sourceNames` so the manager was never prompted to map them.
 */
function nameFromRow(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : String(value);
  const name = raw.trim();
  if (name === '') return null;
  if (monthFromHeader(name) !== null) return null;
  if (name.toLowerCase().startsWith('зміни')) return null;
  // A purely numeric name cell (e.g. a stray total mistakenly left in the name column) is
  // not a person's name. Coercing it to a string name would offer "5" to the manager as
  // someone to map; instead fall through to the existing nameless-row anomaly path, same
  // as before string coercion was introduced for rich-text/formatted name cells.
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(name)) return null;
  return name;
}

/**
 * True if `value` has no real content — null/undefined, or a string that is blank once
 * trimmed. `unknown`-typed and used by both the name-row check and the anomaly
 * classification below so a non-string value (see `nameFromRow`) is judged the same way.
 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const s = typeof value === 'string' ? value : String(value);
  return s.trim() === '';
}

const NAME_COL = 2; // 0-based: spreadsheet column 3

/**
 * Map every month-header column in the sheet to a calendar year.
 *
 * **The sheet is one continuous timeline that crosses a year boundary.** The real workbook runs
 * Травень (May) → Серпень (Aug) across 16 month columns: months ascend 5..12, then restart at
 * 1..8, which is January of the FOLLOWING year. Every month previously took `opts.year`
 * verbatim, so January landed nine months *before* the May start instead of eight months after
 * it — and because the same month name then appeared twice with the same year (c2:m5 and
 * c421:m5), two different columns produced identical dates.
 *
 * Year is derived from **column order**, not from the row a header sits on: columns increase
 * monotonically with time across the whole sheet, whereas headers are scattered over 21 rows.
 * Each time the month number decreases as columns advance, the year rolls forward.
 *
 * Returns a column → year-offset map. Verified against the real workbook: 16 header columns, 16
 * distinct months, offsets 0 for May–Dec and 1 for Jan–Aug.
 */
function yearOffsetByColumn(grid: (string | number | null)[][]): Map<number, number> {
  // Collect the first month seen at each header column, in column order.
  const monthAtCol = new Map<number, number>();
  for (const row of grid) {
    for (let c = 0; c < (row ?? []).length; c++) {
      const month = monthFromHeader((row ?? [])[c]);
      if (month !== null && !monthAtCol.has(c)) monthAtCol.set(c, month);
    }
  }

  const offsets = new Map<number, number>();
  let offset = 0;
  let previousMonth = 0;
  for (const [col, month] of [...monthAtCol].sort((a, b) => a[0] - b[0])) {
    // A decrease means the calendar wrapped past December into the next year.
    if (previousMonth !== 0 && month < previousMonth) offset += 1;
    previousMonth = month;
    offsets.set(col, offset);
  }
  return offsets;
}

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
  const seenMonths = new Set<string>();
  const yearOffsets = yearOffsetByColumn(grid);

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

    /*
     * A block must have its own weekday row directly beneath its header.
     *
     * Without this, a stray month name anywhere in the sheet (a note, a merged label) started a
     * block that then scanned every employee row below it.
     */
    const weekdayRow = grid[r + 1] ?? [];
    const hasWeekdayRow = weekdayRow.some(
      (v) => typeof v === 'string' && WEEKDAYS.has(v.trim().toLowerCase()),
    );
    if (!hasWeekdayRow) continue;

    slot += 1;
    const dayRow = grid[r + 2] ?? [];

    // Day columns are those whose weekday label is a known abbreviation AND whose day-row
    // value is a number. This excludes the trailing shift-count total column, which has a
    // number but no weekday label above it.
    //
    // A day that is syntactically 1-31 but does not exist in the month it's attributed to
    // (a stale day-31 column left over from a copy-pasted 31-day block, in a 30- or 28/29-day
    // month) is kept separate in `invalidDayCols`: it must never produce a dated cell — Postgres
    // would reject the resulting date, and because that isn't a unique violation it would be
    // misreported to the manager as an overlap conflict — so it is routed to an `unparsed`
    // anomaly per populated cell instead.
    const dayCols: { col: number; day: number; month: number; year: number }[] = [];
    const invalidDayCols: { col: number; day: number; month: number; year: number }[] = [];
    for (let c = 0; c < Math.max(weekdayRow.length, dayRow.length); c++) {
      const weekday = typeof weekdayRow[c] === 'string' ? String(weekdayRow[c]).trim().toLowerCase() : '';
      if (!WEEKDAYS.has(weekday)) continue;
      const day = asNumber(dayRow[c] ?? '');
      if (day === null || day < 1 || day > 31) continue;
      // Attribute the column to the right-most month header at or before it.
      let month = monthCols[0].month;
      let headerCol = monthCols[0].startCol;
      for (const mc of monthCols) {
        if (c >= mc.startCol) {
          month = mc.month;
          headerCol = mc.startCol;
        }
      }
      // The year comes from where this month sits in the sheet's overall column order, so a
      // timeline that wraps past December is dated in the following year rather than looping
      // back to January of the start year.
      const year = opts.year + (yearOffsets.get(headerCol) ?? 0);
      // A non-integer day (e.g. '15.5', a fat-fingered or corrupted cell) must never reach a
      // dated cell: it would build a date string like '2026-05-15.5', which Postgres rejects
      // at insert time — and because that rejection is not a unique-constraint violation, the
      // commit route misreports it to the manager as an overlap *conflict* instead of a data
      // problem. Route it through the same invalid-day path as an out-of-range day.
      if (!Number.isInteger(day) || day > daysInMonth(year, month)) {
        invalidDayCols.push({ col: c, day, month, year });
        continue;
      }
      dayCols.push({ col: c, day, month, year });
    }

    if (dayCols.length === 0) {
      // A month header with no usable day columns means the layout was not understood.
      // Never report success silently — an import that yields nothing must say why.
      anomalies.push({
        kind: 'unparsed',
        sourceName: null,
        slot,
        date: null,
        raw: `no day columns resolved for month ${monthCols.map((m) => m.month).join(',')}`,
      });
    }

    // Keyed by year+month, not month alone: the sheet can contain the same month in two
    // different years (May 2026 and May 2027), and a month-only key reported only the first.
    for (const mc of monthCols) {
      const year = opts.year + (yearOffsets.get(mc.startCol) ?? 0);
      const key = `${year}-${mc.month}`;
      if (!seenMonths.has(key)) {
        seenMonths.add(key);
        months.push({ year, month: mc.month });
      }
    }

    // Employee rows run until the next block header (or the end of the grid).
    for (let rr = r + 3; rr < grid.length; rr++) {
      const bodyRow = grid[rr] ?? [];
      if (bodyRow.some((v) => monthFromHeader(v) !== null)) break;

      const rawNameCell = bodyRow[NAME_COL] ?? null;
      const nameCellBlank = isBlank(rawNameCell);
      const name = nameFromRow(rawNameCell);

      for (const dc of dayCols) {
        const raw = bodyRow[dc.col];
        if (raw === null || raw === undefined || String(raw).trim() === '') continue;
        const date = `${dc.year}-${pad(dc.month)}-${pad(dc.day)}`;

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

        const locationNumber = asNumber(raw);
        if (locationNumber === null) {
          // A name instead of a number means someone covered the shift.
          anomalies.push({ kind: 'substitute', sourceName: name, slot, date, raw: String(raw) });
          continue;
        }
        cells.push({
          sourceName: name,
          slot,
          // dc.year, not opts.year — must agree with `date` above, which rolls over.
          year: dc.year,
          month: dc.month,
          day: dc.day,
          date,
          locationNumber,
        });
      }

      // A day column that doesn't exist in its attributed month (stale day-31/30 from a
      // copy-pasted block) must produce no cell — but only report it where the sheet
      // actually has content; an empty cell under an invalid day column is not worth
      // flagging on every single employee row.
      for (const dc of invalidDayCols) {
        const raw = bodyRow[dc.col];
        if (isBlank(raw)) continue;
        const date = `${dc.year}-${pad(dc.month)}-${pad(dc.day)}`;
        anomalies.push({ kind: 'unparsed', sourceName: name, slot, date, raw: String(raw) });
      }

      if (name !== null) sourceNames.add(name);
    }
  }

  return { cells, anomalies, sourceNames: [...sourceNames], months };
}
