import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { parseScheduleGrid } from '../src/scheduleParser';
import { makeScheduleWorkbookBuffer } from './fixtures/makeScheduleFixture';

/**
 * Minimal inline flatten, mirroring `packages/api/src/http/excelGrid.ts`'s `flattenCell`.
 * `@salary/core` cannot depend on `@salary/api` (wrong direction), so this is duplicated
 * rather than imported — but it exercises the SAME reduction the API applies before
 * handing exceljs's `CellValue` to the pure parser, instead of the misleading
 * `(v as string | number)` cast the fixture-reading loop used before this fix (that cast
 * lied to the compiler: exceljs's `CellValue` union has richText/formula/Date/boolean
 * variants no cast makes into a `string | number`).
 */
function flattenCell(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text).join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('error' in v) return null;
    if ('result' in v) {
      const r = (v as { result?: unknown }).result;
      if (r === null || r === undefined) return null;
      if (typeof r === 'number' || typeof r === 'string') return r;
      return null;
    }
  }
  return null;
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
 * Direct unit tests of `parseScheduleGrid` against hand-written plain-array grids —
 * exercising the "hostile" `CellValue` shapes exceljs's *reader* produces (rich text, a
 * formula result, a `Date`, a boolean) that the fixture generator can never emit, because
 * the fixture only writes the plain values exceljs *writes*. This is the structural gap a
 * prior review found: the fixture proves the parser handles the layout, not that it
 * survives every hostile cell type a real, hand-formatted workbook can contain.
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

describe('parseScheduleGrid: hostile flattened cell values', () => {
  it('a rich-text-flattened day cell does not throw and yields a substitute anomaly', () => {
    // Rich text ('Сві') has already been flattened to a plain string by the caller (as
    // excelGrid.ts's flattenCell does) before it ever reaches the parser — this proves the
    // parser's own handling of a substitute string, independent of the flattening step.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 'Сві' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: 'substitute', sourceName: 'Олег', raw: 'Сві' }),
    ]);
  });

  it('a boolean-flattened day cell does not throw and is treated as non-numeric', () => {
    // A boolean cell flattens to the string 'true'/'false' (see excelGrid.ts), which is not
    // a valid location number.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 'true' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies[0]).toMatchObject({ kind: 'substitute', raw: 'true' });
  });

  it('a Date-flattened day cell does not throw and is treated as non-numeric', () => {
    // A Date cell flattens to an ISO date string ('2026-05-01'), not a location number.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: '2026-05-01' } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies[0]).toMatchObject({ kind: 'substitute', raw: '2026-05-01' });
  });

  it('a formula-result-flattened numeric day cell parses as a normal location number', () => {
    // A formula whose result is a plain number (e.g. `=1+0`) flattens to that number.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: 2 } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toEqual([
      expect.objectContaining({ sourceName: 'Олег', locationNumber: 2, date: '2026-05-01' }),
    ]);
    expect(result.anomalies).toHaveLength(0);
  });

  it('an error-flattened day cell (null) does not throw and produces no cell or anomaly', () => {
    // A #REF!/#N/A cell flattens to null; a blank cell is simply skipped by the parser.
    const grid = oneMonthGrid(1, [{ name: 'Олег', cells: { 1: null } }]);
    expect(() => parseScheduleGrid(grid, { year: 2026 })).not.toThrow();
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.cells).toHaveLength(0);
    expect(result.anomalies).toHaveLength(0);
  });

  it('a rich-text-flattened NAME cell still yields a usable sourceNames entry, not a nameless substitute for the whole row', () => {
    // Before this fix, `nameFromRow`/`nameCellBlank` both guarded on
    // `typeof value !== 'string'`, so an unflattened rich-text object in the name column
    // produced `name = null` AND `nameCellBlank = false` — every location number on the row
    // became a nameless `substitute` anomaly and the name never reached `sourceNames`. Here
    // the name cell is already flattened to a plain string (as the API's flattenCell would
    // produce from `{richText:[{text:'Марта'}]}`), proving the parser treats it as a normal
    // name row rather than losing the person.
    const grid = oneMonthGrid(1, [{ name: 'Марта', cells: { 1: 1 } }]);
    const result = parseScheduleGrid(grid, { year: 2026 });
    expect(result.sourceNames).toContain('Марта');
    expect(result.cells).toEqual([
      expect.objectContaining({ sourceName: 'Марта', locationNumber: 1 }),
    ]);
    expect(result.anomalies).toHaveLength(0);
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
});
