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
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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

/** Read a worksheet into the row-major grid `parseScheduleGrid` expects. */
export function gridFromWorksheet(ws: ExcelJS.Worksheet): (string | number | null)[][] {
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
