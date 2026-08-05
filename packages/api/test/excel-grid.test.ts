import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { flattenCell, gridFromWorksheet } from '../src/http/excelGrid';
import { parseScheduleGrid } from '@salary/core';

/**
 * Real unit coverage for `flattenCell`/`gridFromWorksheet`, using RAW exceljs `CellValue`
 * shapes (rich text objects, hyperlink objects, formula-result objects, error objects,
 * actual `Date` instances) rather than pre-flattened plain strings/numbers. The six
 * "hostile flattened cell values" tests in `packages/core/test/scheduleParser.test.ts` feed
 * `parseScheduleGrid` values that are already flattened plain strings — they prove the pure
 * parser tolerates arbitrary strings/numbers, not that `flattenCell` correctly reduces a raw
 * exceljs cell. This file closes that gap.
 */
describe('flattenCell', () => {
  it('flattens rich text to its concatenated plain string', () => {
    expect(flattenCell({ richText: [{ text: 'Сві' }] })).toBe('Сві');
  });

  it('flattens a hyperlink cell to its display text', () => {
    expect(flattenCell({ text: 'link', hyperlink: 'https://example.com' })).toBe('link');
  });

  it('flattens a formula cell with a numeric result to that number', () => {
    expect(flattenCell({ formula: 'A1', result: 7 })).toBe(7);
  });

  it('flattens a formula cell with a null result to null', () => {
    // exceljs's own `CellFormulaValue.result` type omits `null` (only `undefined`), but a
    // formula referencing a blank cell is a real, observed runtime shape; cast to construct it.
    const cell = { formula: 'A1', result: null } as unknown as ExcelJS.CellValue;
    expect(flattenCell(cell)).toBeNull();
  });

  it('flattens an error cell to null', () => {
    expect(flattenCell({ error: '#REF!' })).toBeNull();
  });

  it('flattens a boolean to a non-throwing value', () => {
    expect(() => flattenCell(true)).not.toThrow();
    expect(flattenCell(true)).toBe('true');
  });

  it('flattens a valid Date to the day-of-month NUMBER (FIX A)', () => {
    // Per FIX A: returning an ISO string here made asNumber() return null downstream,
    // silently dropping the whole day column. The day number keeps the cell usable.
    expect(flattenCell(new Date(Date.UTC(2026, 4, 15)))).toBe(15);
  });

  it('flattens new Date(NaN) to null and does NOT throw (regression guard for FIX B root cause)', () => {
    // Pre-fix, `v.toISOString()` on an invalid Date threw `RangeError: Invalid time value`,
    // which escaped gridFromWorksheet uncaught and surfaced as an opaque 500.
    expect(() => flattenCell(new Date(NaN))).not.toThrow();
    expect(flattenCell(new Date(NaN))).toBeNull();
  });
});

describe('gridFromWorksheet', () => {
  it('round-trips a date-typed day-of-month row into a grid that yields parsed cells (FIX A end-to-end)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Графік роботи');
    const weekdays = ['чт', 'пт', 'сб', 'нд', 'пн'];

    // A small one-month, one-slot block: month header, weekday row, and a DATE-TYPED
    // day-of-month row (the spreadsheet auto-fill idiom this fix targets), then one
    // employee row with a location number.
    ws.getCell(3, 3).value = 'Травень';
    for (let d = 1; d <= 5; d++) {
      ws.getCell(4, 3 + d).value = weekdays[d - 1];
      ws.getCell(5, 3 + d).value = new Date(Date.UTC(2026, 4, d)); // Date-typed day cell
    }
    ws.getCell(6, 3).value = 'Олег';
    ws.getCell(6, 4).value = 1; // day 1 -> location 1

    const grid = gridFromWorksheet(ws);
    const result = parseScheduleGrid(grid, { year: 2026 });

    // Before FIX A this was 0 cells / 0 anomalies — a silently "successful" empty import.
    expect(result.cells.length).toBeGreaterThan(0);
    expect(result.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceName: 'Олег', date: '2026-05-01', locationNumber: 1 }),
      ]),
    );
  });
});

describe('gridFromWorksheet performance', () => {
  it('reads a wide, tall sheet in well under a second', async () => {
    /**
     * Regression guard for an O(rows² × cols) bug that made the real workbook un-importable.
     *
     * `ws.rowCount`/`ws.columnCount` are GETTERS, not cached properties: `columnCount` calls
     * `eachRow` and inspects every row's `cellCount` on each access (exceljs 4.4.0,
     * lib/doc/worksheet.js:313). Using `ws.columnCount` directly as the inner-loop bound
     * re-scanned the entire sheet once per row. On the real 1047 × 559 sheet that could not
     * finish 200k iterations in ten minutes; hoisting the bounds reads the whole grid in
     * ~100 ms. API Gateway surfaced the timeout to the manager as a bare 503.
     *
     * Deliberately generous (2s) so this fails on a reintroduced quadratic scan, not on a
     * slow CI runner.
     */
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    const ws = wb.addWorksheet('perf');
    // Sparse but WIDE and TALL — the shape that makes the quadratic cost bite. A dense sheet
    // this size would be slow for legitimate reasons and would not isolate the bug.
    for (let r = 1; r <= 600; r++) {
      ws.getCell(r, 1).value = r;
      ws.getCell(r, 400).value = 'edge';
    }

    const started = Date.now();
    const grid = gridFromWorksheet(ws);
    const elapsed = Date.now() - started;

    expect(grid).toHaveLength(600);
    expect(grid[0]).toHaveLength(400);
    expect(elapsed).toBeLessThan(2000);
  });
});
