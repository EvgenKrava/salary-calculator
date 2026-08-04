import ExcelJS from 'exceljs';

/**
 * Build an in-memory .xlsx reproducing the real "Графік роботи" layout with invented
 * names. Mirrors every quirk the parser must handle — see the design spec §5.1.
 *
 * Layout produced (1-based rows/cols), two months side by side:
 *   col 3            = name column
 *   cols 4..34       = May days 1..31
 *   col 35           = May shift-count total (NOT input)
 *   col 37           = "Червень" header, cols 37..39 = June days 1..3
 *   row r            = month header ("Травень" in col 3)
 *   row r+1          = weekday labels
 *   row r+2          = day-of-month numbers
 *   rows r+3..       = employee name rows (cell value = location number)
 */
export async function makeScheduleWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Графік роботи');
  // A second sheet proves the parser targets the schedule sheet by name.
  wb.addWorksheet('Правила').getCell('A1').value = 'умови закладу';

  const weekdays = ['чт', 'пт', 'сб', 'нд', 'пн', 'вт', 'ср'];

  function writeBlockHeader(row: number): void {
    ws.getCell(row, 3).value = 'Травень';
    for (let d = 1; d <= 31; d++) {
      ws.getCell(row + 1, 3 + d).value = weekdays[(d - 1) % 7];
      ws.getCell(row + 2, 3 + d).value = d; // day-of-month row
    }
    // Second month, offset after the total column — same shape, fewer days.
    ws.getCell(row, 37).value = 'Червень';
    for (let d = 1; d <= 3; d++) {
      ws.getCell(row + 1, 36 + d).value = weekdays[(d + 2) % 7];
      ws.getCell(row + 2, 36 + d).value = d;
    }
  }

  // ---- Slot block 1 (rows 3..) ----
  writeBlockHeader(3);
  ws.getCell(6, 3).value = 'Олег'; // numeric location values
  ws.getCell(6, 4).value = 1;
  ws.getCell(6, 6).value = 2;
  ws.getCell(6, 39).value = 1; // June day 3 (header cols for June are 36+d, so day 3 = col 39)
  ws.getCell(7, 3).value = 'Марта'; // string-typed location values
  ws.getCell(7, 4).value = '2.0';
  ws.getCell(7, 5).value = '1.0';
  ws.getCell(8, 3).value = 'Олег'; // DUPLICATE name inside one block
  ws.getCell(8, 5).value = 2;
  ws.getCell(9, 3).value = 'Бариста 1'; // placeholder row (not a person)
  ws.getCell(9, 4).value = 1;
  ws.getCell(10, 3).value = 'зміни 4.0'; // slot marker row seen in the real sheet
  ws.getCell(10, 5).value = 'Сві'; // substitute-name cell, not a location
  ws.getCell(11, 4).value = 'Загальні збори'; // annotation row (no name in col 3)
  ws.getCell(6, 35).value = 3; // shift-count total column — must be ignored
  ws.getCell(7, 35).value = 2;

  // ---- Slot block 2 (rows 14..) ----
  writeBlockHeader(14);
  ws.getCell(17, 3).value = 'Марта'; // name repeated ACROSS blocks
  ws.getCell(17, 4).value = 1;
  ws.getCell(18, 3).value = 'Тарас';
  ws.getCell(18, 6).value = 3;
  ws.getCell(19, 4).value = 'Інвентура'; // annotation

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
