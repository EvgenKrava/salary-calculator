import type ExcelJS from 'exceljs';

/**
 * Reduce any exceljs CellValue to the plain `string | number | null` the pure parser
 * accepts. exceljs's CellValue union has ten variants — rich text, formulas, dates,
 * errors, hyperlinks — and a hand-formatted cell (very common for the substitute-name
 * cells) arrives as rich text, not a string. Casting instead of flattening made those
 * cells throw a TypeError, surfacing as an opaque 500.
 */
export function flattenCell(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  // A date-formatted cell (spreadsheet auto-fill produces these for day-of-month rows)
  // must yield the DAY NUMBER: returning an ISO string made asNumber() return null, which
  // silently dropped the entire day column and produced an import with zero shifts and
  // zero anomalies. Guard the invalid-date case, which otherwise throws a RangeError that
  // escapes as an opaque 500.
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.getUTCDate();
  }
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text).join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('error' in v) return null;
    if ('result' in v) {
      const r = (v as { result?: unknown }).result;
      if (r === null || r === undefined) return null;
      if (typeof r === 'number' || typeof r === 'string') return r;
      return null; // nested error/date result
    }
  }
  return null;
}

/**
 * Read a worksheet into the row-major grid `parseScheduleGrid` expects.
 *
 * **Read the bounds ONCE.** `ws.rowCount` and `ws.columnCount` are getters, not cached
 * properties: `columnCount` calls `eachRow` and inspects every row's `cellCount` on every
 * access (exceljs 4.4.0, lib/doc/worksheet.js:313). Using `ws.columnCount` as the inner-loop
 * bound therefore re-scanned the whole sheet once per row — O(rows² × cols) instead of
 * O(rows × cols).
 *
 * Measured on the real workbook (1047 × 559 by exceljs's bounds, 585,273 cells): the buggy
 * pattern took 828,957 ms to complete a *capped* 200k iterations; hoisting the bounds reads the
 * FULL grid in ~110 ms. API Gateway surfaced the resulting Lambda timeout to the manager as a
 * bare "503 Service Unavailable" after 31 seconds.
 *
 * Hoisting the two getters is the entire fix. Post-deploy, the real workbook imports in ~4.5 s
 * of Lambda time (477 MB peak) — well inside API Gateway's hard 30 s integration ceiling. No S3
 * upload change and no async pipeline were needed; both were investigated and ruled out.
 * `readFile` itself is only ~470-520 ms, so the parser was never the slow part.
 */
export function gridFromWorksheet(ws: ExcelJS.Worksheet): (string | number | null)[][] {
  const rowCount = ws.rowCount;
  const columnCount = ws.columnCount;
  const grid: (string | number | null)[][] = [];
  for (let r = 1; r <= rowCount; r++) {
    const row: (string | number | null)[] = [];
    for (let c = 1; c <= columnCount; c++) {
      row.push(flattenCell(ws.getCell(r, c).value));
    }
    grid.push(row);
  }
  return grid;
}
