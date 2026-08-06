import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { parseScheduleGrid } from '../src/scheduleParser';
import { makeScheduleWorkbookBuffer } from './fixtures/makeScheduleFixture';

/**
 * FIX G decision: a prior version of this file duplicated `packages/api/src/http/
 * excelGrid.ts`'s full `flattenCell` verbatim, claiming to "mirror" it. That duplicate was
 * dead-code cosplay: `makeScheduleWorkbookBuffer` (below) only ever writes plain strings and
 * numbers to cells — it never produces rich text, a formula, a hyperlink, a boolean, or a
 * `Date`. The elaborate branches existed only to look like parity while never actually
 * running, which is exactly the drift risk the reviewer flagged (a change to the real
 * `flattenCell` would not be caught here either way, since these branches are unreachable
 * with this fixture).
 *
 * `@salary/core` cannot depend on `@salary/api` (wrong dependency direction), so this stays
 * a separate, LOCAL helper — but it is now scoped to only what this fixture can actually
 * produce (`string | number | null`), so there is nothing here to drift out of sync with.
 * The real hostile-`CellValue` coverage (rich text, hyperlink, formula, error, boolean, and
 * both valid and invalid `Date`) lives in `packages/api/test/excel-grid.test.ts`, which
 * calls the genuine `flattenCell` directly — change that file, not this one, if `flattenCell`
 * changes.
 */
function flattenCell(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  throw new Error(
    `fixtureGrid() received a cell value this fixture never writes: ${JSON.stringify(v)}. ` +
      'If makeScheduleFixture.ts started writing richText/formula/Date/boolean cells, this ' +
      'local flatten would need those branches back — see excel-grid.test.ts for the real ones.',
  );
}

/** Read the fixture's schedule sheet into the row-major grid the parser expects. */
async function fixtureGrid(): Promise<(string | number | null)[][]> {
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled .d.ts declares its own module-local `Buffer` (extends `ArrayBuffer`),
  // which no longer structurally matches @types/node's `Buffer<ArrayBufferLike>` — a stale
  // type declaration, not a runtime incompatibility. Cast to satisfy the declared signature.
  await wb.xlsx.load(await makeScheduleWorkbookBuffer() as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Графік роботи')!;
  const grid: (string | number | null)[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row: (string | number | null)[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      row.push(flattenCell(ws.getCell(r, c).value));
    }
    grid.push(row);
  }
  return grid;
}

describe('parseScheduleGrid', () => {
  let result: ReturnType<typeof parseScheduleGrid>;

  beforeAll(async () => {
    result = parseScheduleGrid(await fixtureGrid(), { year: 2026 });
  });

  it('finds both months present in the sheet', () => {
    expect(result.months).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });

  it('parses a numeric location cell into a dated shift', () => {
    const cell = result.cells.find((c) => c.sourceName === 'Олег' && c.date === '2026-05-01');
    expect(cell).toMatchObject({ slot: 1, locationNumber: 1, date: '2026-05-01' });
  });

  it('parses a string-typed location cell', () => {
    const cell = result.cells.find((c) => c.sourceName === 'Марта' && c.date === '2026-05-01');
    expect(cell).toMatchObject({ slot: 1, locationNumber: 2 });
  });

  it('keeps duplicate names within a block as separate rows', () => {
    // Two different people are both written "Олег" in block 1; the parser must not merge
    // them — it reports the name and lets the mapping step disambiguate. An exact cell count
    // catches regressions where a future change silently dedupes and drops one duplicate row.
    const olegCells = result.cells.filter((c) => c.sourceName === 'Олег' && c.slot === 1);
    expect(olegCells.length).toBe(4);
    // Explicitly verify the duplicate row (row 8) is present via its distinguishing cell.
    expect(olegCells.some((c) => c.date === '2026-05-02')).toBe(true);
  });

  it('assigns rows in the second block to slot 2', () => {
    const taras = result.cells.find((c) => c.sourceName === 'Тарас');
    expect(taras).toMatchObject({ slot: 2, locationNumber: 3 });
  });

  it('parses the second month with the correct dates', () => {
    const june = result.cells.find((c) => c.date.startsWith('2026-06'));
    expect(june).toMatchObject({ sourceName: 'Олег', date: '2026-06-03', locationNumber: 1 });
  });

  it('ignores the shift-count total column', () => {
    // The total column holds 3 and 2 for the first two rows; neither is a location on a day.
    expect(result.cells.some((c) => c.locationNumber === 3 && c.sourceName === 'Олег')).toBe(false);
  });

  it('reports a substitute-name cell as an anomaly, not a shift', () => {
    const sub = result.anomalies.find((a) => a.raw === 'Сві');
    expect(sub?.kind).toBe('substitute');
    // `Number.NaN === Number.NaN` is always false, so the previous version of this
    // assertion (`c.locationNumber === Number.NaN`) was vacuously true regardless of the
    // parser's behaviour. `Number.isNaN` actually detects a NaN location number.
    expect(result.cells.some((c) => Number.isNaN(c.locationNumber))).toBe(false);
  });

  it('reports annotation rows as anomalies', () => {
    expect(result.anomalies.some((a) => a.kind === 'annotation' && a.raw.includes('Загальні'))).toBe(true);
    expect(result.anomalies.some((a) => a.kind === 'annotation' && a.raw.includes('Інвентура'))).toBe(true);
  });

  it('keeps a name repeated across blocks as separate slot rows', () => {
    // "Марта" appears in both block 1 (slot 1) and block 2 (slot 2); the parser must keep
    // them as distinct cells to avoid losing assignment information during the mapping step.
    const marta1 = result.cells.some((c) => c.sourceName === 'Марта' && c.slot === 1);
    const marta2 = result.cells.some((c) => c.sourceName === 'Марта' && c.slot === 2);
    expect(marta1).toBe(true);
    expect(marta2).toBe(true);
  });

  it('lists every distinct source name for the mapping step', () => {
    expect(result.sourceNames).toEqual(expect.arrayContaining(['Олег', 'Марта', 'Бариста 1', 'Тарас']));
  });

  it('excludes the slot marker row from source names', () => {
    expect(result.sourceNames.some((n) => n.startsWith('зміни'))).toBe(false);
  });
});

/**
 * Direct unit tests of `parseScheduleGrid` against hand-written plain-array grids, feeding
 * the ALREADY-FLATTENED `string | number | null` values that `excelGrid.ts`'s `flattenCell`
 * would have produced from various raw exceljs `CellValue` shapes (rich text, a formula
 * result, a `Date`, a boolean). Because the values here are pre-flattened plain strings and
 * numbers, these tests exercise `parseScheduleGrid`'s own tolerance of those values — they do
 * NOT exercise `flattenCell` itself, and they prove nothing about a crash occurring inside
 * the flattening step (a raw, unflattened `CellValue` — e.g. an actual `Date` object or a
 * `{richText:[...]}` object — is never constructed here). A real regression guard for the
 * flattening step lives in `packages/api/test/excel-grid.test.ts`, which calls `flattenCell`/
 * `gridFromWorksheet` with genuine raw exceljs shapes.
 *
 * Grid layout (0-based rows/cols), one slot block, one month, matching the real sheet's
 * column positions (name at col 2 — `NAME_COL` in the parser is hardcoded — days from
 * col 3):
 *   row 0, col 2          = month header (e.g. "Травень")
 *   row 1, cols 3..3+N-1  = weekday labels
 *   row 2, cols 3..3+N-1  = day-of-month numbers (1..N)
 *   row 3+, col 2         = employee name; cols 3..3+N-1 = day cells (by day number, 1-based)
 */
function oneMonthGrid(
  days: number,
  nameRows: { name: string | number | null; cells: Record<number, string | number | null> }[],
  opts: { month?: string; weekdayStart?: number } = {},
): (string | number | null)[][] {
  const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
  const start = opts.weekdayStart ?? 0;
  const width = 3 + days;

  function blankRow(): (string | number | null)[] {
    return Array(width).fill(null);
  }

  const header = blankRow();
  header[2] = opts.month ?? 'Травень';
  const weekdayRow = blankRow();
  const dayRow = blankRow();
  for (let d = 1; d <= days; d++) {
    weekdayRow[2 + d] = weekdays[(start + d - 1) % 7];
    dayRow[2 + d] = d;
  }

  const rows: (string | number | null)[][] = [header, weekdayRow, dayRow];
  for (const nr of nameRows) {
    const row = blankRow();
    row[2] = nr.name;
    for (const [day, value] of Object.entries(nr.cells)) {
      row[2 + Number(day)] = value;
    }
    rows.push(row);
  }
  return rows;
}

describe('parseScheduleGrid: tolerance of already-flattened values (does NOT cover flattenCell itself)', () => {
  it('a value shaped like a flattened rich-text day cell does not throw and yields a substitute anomaly', () => {
    // 'Сві' is the plain string flattenCell would produce from rich text — it is written
    // here directly as a string, so this exercises only the parser's handling of an
    // arbitrary non-numeric string in a day cell, not the flattening of rich text itself.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 'Сві' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: 'substitute', sourceName: 'Олег', raw: 'Сві' }),
    ]);
  });

  it('a value shaped like a flattened boolean day cell does not throw and is treated as non-numeric', () => {
    // 'true' is the plain string flattenCell would produce from a boolean cell — written
    // directly as a string; no boolean is ever constructed in this test.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 'true' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies[0]).toMatchObject({ kind: 'substitute', raw: 'true' });
  });

  it('a value shaped like a flattened Date day cell does not throw and is treated as non-numeric', () => {
    // '2026-05-01' is an arbitrary non-numeric string here; no Date object is constructed,
    // so this does not exercise flattenCell's actual Date handling (see FIX A / excel-grid
    // test for that — a real Date in a day cell must flatten to a day NUMBER, not this).
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: '2026-05-01' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies[0]).toMatchObject({ kind: 'substitute', raw: '2026-05-01' });
  });

  it('a plain numeric day cell (as a flattened formula result would be) parses as a normal location number', () => {
    // A formula whose result is a plain number (e.g. `=1+0`) flattens to that number; written
    // directly as a number here.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 2 } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toEqual([
      expect.objectContaining({ sourceName: 'Олег', locationNumber: 2, date: '2026-05-01' }),
    ]);
    expect(result.anomalies).toHaveLength(0);
  });

  it('a null cell (as a flattened error cell would be) does not throw and produces no cell or anomaly', () => {
    // A #REF!/#N/A cell flattens to null; a blank cell is simply skipped by the parser.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: null } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies).toHaveLength(0);
  });

  it('a plain-string NAME cell (as a flattened rich-text name would be) still yields a usable sourceNames entry, not a nameless substitute for the whole row', () => {
    // Before an earlier fix, `nameFromRow`/`nameCellBlank` both guarded on
    // `typeof value !== 'string'`, so an unflattened rich-text object in the name column
    // produced `name = null` AND `nameCellBlank = false` — every location number on the row
    // became a nameless `substitute` anomaly and the name never reached `sourceNames`. This
    // test writes the name cell as an already-flattened plain string, so it proves the
    // parser's own name-row handling, not that a raw rich-text object flattens correctly.
    const grid = oneMonthGrid(1, [{ name: 'Марта', cells: { 1: 1 } }]);
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.sourceNames).toContain('Марта');
    expect(result.cells).toEqual([
      expect.objectContaining({ sourceName: 'Марта', locationNumber: 1 }),
    ]);
    expect(result.anomalies).toHaveLength(0);
  });

  it('a purely numeric name cell is not treated as a person name (FIX E)', () => {
    // A stray total or other numeric artifact in the name column must not be coerced into
    // a fake person "5" offered for mapping; it should fall through to the nameless-row
    // anomaly path like any other non-name content.
    const grid = oneMonthGrid(1, [{ name: 5, cells: { 1: 1 } }]);
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.sourceNames).not.toContain('5');
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: 'substitute', sourceName: null, raw: '1' }),
    ]);
  });
});

describe('parseScheduleGrid: invalid day-of-month guard (FIX 2)', () => {
  it('a day-31 column in June (30 days) produces no cell and exactly one unparsed anomaly per populated cell', () => {
    // June has 30 days; a day-31 column is a stale artifact of a copy-pasted 31-day block.
    const grid = oneMonthGrid(31, [{ name: 'Олег', cells: { 1: 1, 31: 2 } }], { month: 'Червень' });
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells.some((c) => c.date === '2026-06-31')).toBe(false);
    const unparsed = result.anomalies.filter((a) => a.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toMatchObject({ sourceName: 'Олег', date: '2026-06-31', raw: '2' });
    // The valid day 1 in this row is unaffected.
    expect(result.cells).toEqual([
      expect.objectContaining({ date: '2026-06-01', locationNumber: 1 }),
    ]);
  });

  it('a day-30 column in February (28/29 days) is also rejected', () => {
    const grid = oneMonthGrid(30, [{ name: 'Олег', cells: { 30: 5 } }], { month: 'Лютий' });
    const result = parseScheduleGrid(grid, { year: 2026 }); // 2026 is not a leap year
    expect(result.cells.some((c) => c.date === '2026-02-30')).toBe(false);
    expect(result.anomalies.filter((a) => a.kind === 'unparsed')).toHaveLength(1);
    expect(result.anomalies.find((a) => a.kind === 'unparsed')).toMatchObject({
      sourceName: 'Олег',
      date: '2026-02-30',
      raw: '5',
    });
  });

  it('a non-integer day-of-month value (e.g. "15.5") is rejected, not silently truncated into a dated cell (FIX C)', () => {
    // A day row value of '15.5' is syntactically in range (1-31) but not a whole day number.
    // Before FIX C, `asNumber` accepted it and the parser built the date string
    // '2026-05-15.5' — a clean cell, zero anomalies — which Postgres would reject at insert
    // time; because that rejection is not a unique-constraint violation, the commit route
    // would misreport it to the manager as an overlap *conflict* rather than a data problem.
    // A second, ordinary day-1 column is included alongside the "15.5" day-2 column so this
    // block has at least one resolved day column — isolating the FIX C assertion from the
    // separate FIX A "no day columns resolved" defence-in-depth anomaly.
    const grid: (string | number | null)[][] = [
      [null, null, 'Травень', null, null],
      [null, null, null, 'чт', 'пт'],
      [null, null, null, 1, '15.5'],
      [null, null, 'Олег', 3, 1],
    ];
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells.some((c) => c.date.includes('15.5'))).toBe(false);
    expect(result.cells).toEqual([
      expect.objectContaining({ date: '2026-05-01', locationNumber: 3 }),
    ]);
    const unparsed = result.anomalies.filter((a) => a.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toMatchObject({ sourceName: 'Олег', raw: '1' });
  });

  it('does not report an unparsed anomaly for an empty cell under an invalid day column', () => {
    // Only populated cells under an invalid day column are worth flagging — an empty cell
    // there is not an error on the manager's part. Day 31 is left unset (blank) here.
    const grid = oneMonthGrid(31, [{ name: 'Олег', cells: { 1: 1 } }], { month: 'Червень' });
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.anomalies.filter((a) => a.kind === 'unparsed')).toHaveLength(0);
  });

  it('a valid day-31 in a 31-day month (May) still parses normally, proving the fix does not over-reject', () => {
    const grid = oneMonthGrid(31, [{ name: 'Олег', cells: { 31: 3 } }], { month: 'Травень' });
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.anomalies.filter((a) => a.kind === 'unparsed')).toHaveLength(0);
    expect(result.cells).toEqual([
      expect.objectContaining({ date: '2026-05-31', locationNumber: 3 }),
    ]);
  });

  it('leap year: 2024-02-29 is accepted', () => {
    const grid = oneMonthGrid(29, [{ name: 'Олег', cells: { 29: 1 } }], { month: 'Лютий' });
    const result = parseScheduleGrid(grid, { year: 2024 }); // 2024 is a leap year
    expect(result.anomalies.filter((a) => a.kind === 'unparsed')).toHaveLength(0);
    expect(result.cells).toEqual([
      expect.objectContaining({ date: '2024-02-29', locationNumber: 1 }),
    ]);
  });

  it('leap year: 2025-02-29 is rejected with exactly one unparsed anomaly', () => {
    const grid = oneMonthGrid(29, [{ name: 'Олег', cells: { 29: 1 } }], { month: 'Лютий' });
    const result = parseScheduleGrid(grid, { year: 2025 }); // 2025 is not a leap year
    expect(result.cells.some((c) => c.date === '2025-02-29')).toBe(false);
    const unparsed = result.anomalies.filter((a) => a.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toMatchObject({ sourceName: 'Олег', date: '2025-02-29', raw: '1' });
  });

  it('day validation uses the ATTRIBUTED month, not the leftmost: a May-31 column parses while a June-31 column in the same row is rejected', () => {
    // A single row carries two month headers, mirroring the real sheet's side-by-side
    // month blocks. Column attribution is "right-most month header at or before" the
    // column, so the June columns (to the right of the June header) must be validated
    // against June's day count (30), not May's (31), even though May is the leftmost —
    // and thus first-seen — month in the row.
    const grid: (string | number | null)[][] = [
      // row 0: month headers — 'Травень' (May) at col 2, 'Червень' (June) at col 5
      [null, null, 'Травень', null, null, 'Червень', null, null],
      // row 1: weekday labels for May day1 (col3), May day31 (col4), June day1 (col6), June day31 (col7)
      [null, null, null, 'чт', 'чт', null, 'чт', 'чт'],
      // row 2: day-of-month numbers
      [null, null, null, 1, 31, null, 1, 31],
      // row 3: employee row — May day1=1, May day31=3, June day1=1, June day31=2
      [null, null, 'Олег', 1, 3, null, 1, 2],
    ];
    const result = parseScheduleGrid(grid, { year: 2026 });

    // May has 31 days: the May-31 column parses normally.
    expect(result.cells).toEqual(
      expect.arrayContaining([expect.objectContaining({ date: '2026-05-31', locationNumber: 3 })]),
    );
    // June has 30 days: the June-31 column is rejected, not silently misattributed to May.
    expect(result.cells.some((c) => c.date === '2026-06-31')).toBe(false);
    const unparsed = result.anomalies.filter((a) => a.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toMatchObject({ sourceName: 'Олег', date: '2026-06-31', raw: '2' });
    // Both months' day-1 columns parse fine.
    expect(result.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-05-01', locationNumber: 1 }),
        expect.objectContaining({ date: '2026-06-01', locationNumber: 1 }),
      ]),
    );
  });
});

/**
 * Year rollover across a workbook that spans two calendar years.
 *
 * The real client workbook is ONE continuous timeline: Травень (May) 2026 → Серпень (Aug) 2027,
 * laid out left-to-right as months 5..12 then 1..8. Every month previously took `opts.year`
 * verbatim, so:
 *  - January landed in 2026 — nine months BEFORE the May start instead of eight months after it;
 *  - the same month name appeared twice with the same year (May 2026 twice), so two different
 *    columns produced identical dates for the same person, and the commit route rejected the
 *    import as overlapping shifts.
 *
 * Built as a hand-written grid rather than an xlsx fixture: the parser takes a grid, and the
 * bug is about column order, which is exactly what a literal grid states plainly.
 */
describe('parseScheduleGrid: year rollover (two-year timeline)', () => {
  /**
   * Two month blocks side by side — Грудень (12) then Січень (1) — the boundary where the
   * calendar wraps. Layout per block: header row, weekday row, day row, then one name row.
   */
  function twoYearGrid(): (string | number | null)[][] {
    const width = 12;
    const blank = (): (string | number | null)[] => Array.from({ length: width }, () => null);

    const header = blank();
    header[3] = 'Грудень';
    header[8] = 'Січень';

    const weekdays = blank();
    const days = blank();
    // Two day columns per month is enough to date a cell; the weekday label is what marks a
    // column as a day column at all.
    weekdays[4] = 'пн';
    days[4] = 1;
    weekdays[5] = 'вт';
    days[5] = 2;
    weekdays[9] = 'чт';
    days[9] = 1;
    weekdays[10] = 'пт';
    days[10] = 2;

    const nameRow = blank();
    nameRow[2] = 'Олена';
    nameRow[4] = 1; // 1 Dec
    nameRow[9] = 2; // 1 Jan — must be the FOLLOWING year

    return [header, weekdays, days, nameRow];
  }

  it('dates a month after December in the following year', () => {
    const out = parseScheduleGrid(twoYearGrid(), { year: 2026 });
    const dates = out.cells.map((c) => c.date).sort();
    expect(dates).toEqual(['2026-12-01', '2027-01-01']);
  });

  it('reports the rolled-over year on the cell, not just in the date string', () => {
    const out = parseScheduleGrid(twoYearGrid(), { year: 2026 });
    const jan = out.cells.find((c) => c.month === 1)!;
    // `year` and `date` must agree — the commit route filters on `year` and the DB stores `date`.
    expect(jan.year).toBe(2027);
    expect(jan.date.startsWith('2027-')).toBe(true);
  });

  it('lists both years in `months`, keyed by year+month', () => {
    const out = parseScheduleGrid(twoYearGrid(), { year: 2026 });
    expect(out.months).toEqual(
      expect.arrayContaining([
        { year: 2026, month: 12 },
        { year: 2027, month: 1 },
      ]),
    );
  });

  it('does not roll over a single-year workbook', () => {
    // Guards against the rollover firing on ascending months, which would break every
    // existing single-year import.
    const grid: (string | number | null)[][] = [
      [null, null, null, 'Травень', null, null, 'Червень', null],
      [null, null, null, null, 'пн', null, null, 'ср'],
      [null, null, null, null, 1, null, null, 1],
      [null, null, 'Олена', null, 1, null, null, 2],
    ];
    const out = parseScheduleGrid(grid, { year: 2026 });
    expect(out.cells.every((c) => c.year === 2026)).toBe(true);
    expect(out.cells.map((c) => c.date).sort()).toEqual(['2026-05-01', '2026-06-01']);
  });

  it('validates day-of-month against the rolled-over year, not the base year', () => {
    // 29 Feb exists in 2028 but not in 2027. A block running Dec 2027 → Feb 2028 must accept it;
    // validating against the base year would reject a real date as a stale copy-paste column.
    const grid: (string | number | null)[][] = [
      [null, null, null, 'Грудень', null, null, null, 'Лютий', null],
      [null, null, null, null, 'пн', null, null, null, 'вт'],
      [null, null, null, null, 1, null, null, null, 29],
      [null, null, 'Олена', null, 1, null, null, null, 1],
    ];
    const out = parseScheduleGrid(grid, { year: 2027 });
    expect(out.cells.map((c) => c.date).sort()).toEqual(['2027-12-01', '2028-02-29']);
    expect(out.anomalies.filter((a) => a.kind === 'unparsed')).toHaveLength(0);
  });
});
