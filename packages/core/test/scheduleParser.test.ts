import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { parseScheduleGrid } from '../src/scheduleParser';
import { makeScheduleWorkbookBuffer } from './fixtures/makeScheduleFixture';

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
      const v = ws.getCell(r, c).value;
      row.push(v === null || v === undefined ? null : (v as string | number));
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
    const igor = result.cells.find((c) => c.sourceName === 'Ігор');
    expect(igor).toMatchObject({ slot: 2, locationNumber: 3 });
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
    expect(result.cells.some((c) => c.locationNumber === Number.NaN)).toBe(false);
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
    expect(result.sourceNames).toEqual(expect.arrayContaining(['Олег', 'Марта', 'Бариста 1', 'Ігор']));
  });

  it('excludes the slot marker row from source names', () => {
    expect(result.sourceNames.some((n) => n.startsWith('зміни'))).toBe(false);
  });
});
