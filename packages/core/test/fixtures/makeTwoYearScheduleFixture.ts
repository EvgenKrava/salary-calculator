import ExcelJS from 'exceljs';

/**
 * Build an in-memory .xlsx whose schedule crosses a calendar-year boundary.
 *
 * The real client workbook is ONE continuous timeline — Травень (May) 2026 → Серпень (Aug) 2027 —
 * laid out left to right as months 5..12 then 1..8. This fixture reproduces the boundary in
 * miniature (Грудень then Січень) so two bugs stay fixed:
 *
 *  1. **Parser**: every month used to take the base `year`, so January was dated nine months
 *     *before* the December beside it instead of one month after.
 *  2. **Commit route**: it filtered cells by month alone, so `month=1` matched January of BOTH
 *     years. On the real file, committing one month selected 415 cells across two years instead
 *     of 191, and the same person on the same day-of-month in two different years was then
 *     reported to the manager as an overlapping-shift conflict.
 *
 * Kept separate from `makeScheduleFixture` rather than folded into it: that fixture is the
 * single-year layout many tests assert against, and widening it would change their expectations
 * for reasons unrelated to what they test.
 *
 * Layout (1-based rows/cols):
 *   col 3        = name column
 *   col 3        = "Грудень" header, cols 4..6   = Dec days 1..3
 *   col 10       = "Січень" header, cols 11..13  = Jan days 1..3  (the following year)
 *   row 3        = month headers
 *   row 4        = weekday labels
 *   row 5        = day-of-month numbers
 *   rows 6..     = employee rows, cell value = location number
 */
export async function makeTwoYearScheduleWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Графік роботи');

  ws.getCell(3, 3).value = 'Грудень';
  ws.getCell(3, 10).value = 'Січень';

  // Weekday labels are what mark a column as a day column; the exact day names do not matter to
  // the parser, only that they are recognised abbreviations.
  const weekdays = ['пн', 'вт', 'ср'];
  for (let d = 1; d <= 3; d++) {
    ws.getCell(4, 3 + d).value = weekdays[d - 1];
    ws.getCell(5, 3 + d).value = d;
    ws.getCell(4, 10 + d).value = weekdays[d - 1];
    ws.getCell(5, 10 + d).value = d;
  }

  /*
   * The same person on the same DAY-OF-MONTH in both years, at location 1.
   *
   * This is the shape that broke the commit route: filtered by month alone, both rows were
   * selected for one import, and the second was reported as an overlap conflict.
   */
  ws.getCell(6, 3).value = 'Олег';
  ws.getCell(6, 4).value = 1; // 1 December, base year
  ws.getCell(6, 11).value = 1; // 1 January, base year + 1

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
