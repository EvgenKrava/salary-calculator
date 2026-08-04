# Spreadsheet Schedule Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager upload the business's real `.xlsx` work schedule, review what was parsed, and commit it as `imported` shifts — turning the existing Excel workflow into scheduled shifts the payroll engine can use.

**Architecture:** Three layers, built in dependency order. (1) A **pure parser** in `@salary/core` (`parseScheduleWorkbook`) that turns a worksheet grid into `ParsedShiftCell[]` — no DB, no HTTP, tested against a synthetic fixture that reproduces the real layout. (2) **Setup tables** the parser's output needs to become real shifts: `location_shift_slots` (slot windows per location) and `schedule_name_map` (persisted name-row → employee mapping), with admin/manager CRUD. (3) An **API import flow**: `POST /api/schedule-imports/preview` (parse + resolve + report what's unmapped/unconfigured, writes nothing) and `POST /api/schedule-imports/commit` (write the selected period's shifts). The parser is deliberately ignorant of the database so the risky part — reading real spreadsheet data — is provable in isolation.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `exceljs` for `.xlsx` reading, PGlite, Drizzle ORM, Hono, Zod.

## Global Constraints

- **Node** `>=20`, **pnpm**. TypeScript strict, ESM, extensionless relative imports.
- **Reference:** `docs/superpowers/specs/2026-08-03-salary-calculator-design.md` §5.1 (spreadsheet layout and import rules) — the authority for layout facts below.
- **Verified layout facts** (from the real workbook, sheet `Графік роботи`): months run **horizontally** (May = day columns 4–34, June starts at column 37); a weekday row sits directly above a day-of-month row; vertical **blocks are shift slots**; a cell value is the **location number**; a per-month **shift-count total column** follows each month's days and is NOT input; cells may hold an **abbreviated substitute name** instead of a number; some rows are **annotations** (`Загальні збори`, `Інвентура`, `Навчання`, `meeting`, `Латте арт`, `Генеральне`).
- **Numbers may be numeric or string** in the same sheet (`1.0` and `'2.0'` both occur) — the parser must accept both.
- **Never guess who gets paid.** A name-row with no confirmed mapping is reported, never auto-assigned. Placeholder rows (`Бариста 1`, `Бариста Н`) are mappable to "ignored".
- **Never guess times.** A (location, slot) with no configured window is reported; the importer does not invent one.
- **The manager picks the period.** Preview parses everything found; commit writes only the requested period.
- **Imported shifts** are written with `source = 'imported'` and must satisfy the existing overlap rule (no two approved shifts overlapping for one employee across any location) and the whole-minute/`<24:00` DB constraints.
- **Test fixture is synthetic.** The real workbook contains staff names and is gitignored (`docs/*.xlsx`). Parser tests use a generated fixture that reproduces the layout with invented names.

---

### Task 1: Synthetic fixture generator

**Files:**
- Create: `packages/core/test/fixtures/makeScheduleFixture.ts`
- Create: `packages/core/test/fixtures/README.md`
- Modify: `packages/core/package.json` (add `exceljs` dev dependency)

**Interfaces:**
- Consumes: nothing.
- Produces: `makeScheduleWorkbookBuffer(): Promise<Buffer>` — an in-memory `.xlsx` whose `Графік роботи` sheet reproduces the real layout with invented names. Consumed by Task 2's parser tests.

The fixture must reproduce every quirk the parser has to survive, or the tests prove nothing:
horizontal months, a weekday row above a day row, multiple slot blocks, numeric AND
string-typed location values, a duplicate name within one block, a name repeated across
blocks, a placeholder row, a substitute-name cell, an annotation row, and a trailing
shift-count total column.

- [ ] **Step 1: Add the exceljs dev dependency**

In `packages/core/package.json`, add to `devDependencies`:
```json
    "exceljs": "^4.4.0",
```
Run: `pnpm install`
Expected: `exceljs` resolves for `@salary/core` with no errors.

- [ ] **Step 2: Write the fixture generator**

`packages/core/test/fixtures/makeScheduleFixture.ts`:
```ts
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
  ws.getCell(6, 40).value = 1; // June day 3
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
```

`packages/core/test/fixtures/README.md`:
```markdown
# Test fixtures

`makeScheduleFixture.ts` generates a synthetic `.xlsx` in memory that reproduces the
layout of the client's real `Графік роботи Coffee Shop.xlsx` — horizontal months, shift-slot
blocks, location-number cells, duplicate names, substitute abbreviations, annotation rows and
a trailing total column — using invented names.

The real workbook is **not** committed: it contains actual staff names and business data and
is gitignored via `docs/*.xlsx`. Keep it local. If the parser needs to be checked against it,
point a scratch script at the local path — never add it to the repo.
```

- [ ] **Step 3: Verify the fixture generates**

Run: `pnpm --filter @salary/core exec node --input-type=module -e "import('./test/fixtures/makeScheduleFixture.ts').then(()=>console.log('module loads'))"`
Expected: this may fail because Node cannot import `.ts` directly — that is fine and not a
gate. The real proof is Task 2's tests consuming it. Skip ahead if it errors on the TS import;
do NOT add a build step or a loader for this.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json packages/core/test/fixtures pnpm-lock.yaml
git commit -m "Add synthetic schedule workbook fixture generator"
```

---

### Task 2: Pure schedule parser in `@salary/core`

**Files:**
- Create: `packages/core/src/scheduleParser.ts`
- Modify: `packages/core/src/index.ts` (export the parser + its types)
- Test: `packages/core/test/scheduleParser.test.ts`

**Interfaces:**
- Consumes: the fixture (Task 1).
- Produces:
  - `interface ParsedShiftCell { sourceName: string; slot: number; year: number; month: number; day: number; date: string; locationNumber: number }`
  - `interface ParsedAnomaly { kind: 'substitute' | 'annotation' | 'unparsed'; sourceName: string | null; slot: number; date: string | null; raw: string }`
  - `interface ParseResult { cells: ParsedShiftCell[]; anomalies: ParsedAnomaly[]; sourceNames: string[]; months: { year: number; month: number }[] }`
  - `parseScheduleGrid(grid: (string | number | null)[][], opts: { year: number }): ParseResult` — pure, takes a 2-D grid (row-major, 0-based) so it has no file/IO dependency.

The parser is **pure and grid-based**; reading the `.xlsx` into a grid is the caller's job
(Task 5 does it in the API). This keeps the risky layout logic unit-testable and keeps
`exceljs` out of `@salary/core`'s runtime dependencies.

- [ ] **Step 1: Write the failing parser test**

`packages/core/test/scheduleParser.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { parseScheduleGrid } from '../src/scheduleParser';
import { makeScheduleWorkbookBuffer } from './fixtures/makeScheduleFixture';

/** Read the fixture's schedule sheet into the row-major grid the parser expects. */
async function fixtureGrid(): Promise<(string | number | null)[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await makeScheduleWorkbookBuffer());
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
    // them — it reports the name and lets the mapping step disambiguate.
    const olegCells = result.cells.filter((c) => c.sourceName === 'Олег' && c.slot === 1);
    expect(olegCells.length).toBeGreaterThanOrEqual(3);
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
    expect(result.cells.some((c) => c.locationNumber === Number.NaN)).toBe(false);
  });

  it('reports annotation rows as anomalies', () => {
    expect(result.anomalies.some((a) => a.kind === 'annotation' && a.raw.includes('Загальні'))).toBe(true);
    expect(result.anomalies.some((a) => a.kind === 'annotation' && a.raw.includes('Інвентура'))).toBe(true);
  });

  it('lists every distinct source name for the mapping step', () => {
    expect(result.sourceNames).toEqual(expect.arrayContaining(['Олег', 'Марта', 'Бариста 1', 'Тарас']));
  });

  it('excludes the slot marker row from source names', () => {
    expect(result.sourceNames.some((n) => n.startsWith('зміни'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/core test scheduleParser`
Expected: FAIL — cannot resolve `../src/scheduleParser`.

- [ ] **Step 3: Implement the parser**

`packages/core/src/scheduleParser.ts`:
```ts
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

      const name = nameFromRow(bodyRow[NAME_COL] ?? null);

      for (const dc of dayCols) {
        const raw = bodyRow[dc.col];
        if (raw === null || raw === undefined || String(raw).trim() === '') continue;
        const date = `${opts.year}-${pad(dc.month)}-${pad(dc.day)}`;

        if (name === null) {
          // Text on a row with no name is a schedule annotation (meeting, inventory...).
          anomalies.push({ kind: 'annotation', sourceName: null, slot, date, raw: String(raw) });
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
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, add:
```ts
export { parseScheduleGrid } from './scheduleParser';
export type { ParsedShiftCell, ParsedAnomaly, ParseResult } from './scheduleParser';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @salary/core test scheduleParser`
Then: `pnpm --filter @salary/core test && pnpm --filter @salary/core typecheck`
Expected: PASS — parser tests green and the rest of core unaffected.

If a test fails, fix the PARSER, not the expectation — the fixture encodes the real layout.
The one exception: if the fixture itself is wrong about the real sheet (e.g. the total column
does have a weekday label above it), correct the fixture and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduleParser.ts packages/core/src/index.ts packages/core/test/scheduleParser.test.ts
git commit -m "Add pure schedule grid parser"
```

---

### Task 3: Slot-window and name-map tables

**Files:**
- Create: `packages/core/db/migrations/0003_schedule_import.sql`
- Modify: `packages/core/src/migrations.ts` (add to `MIGRATIONS`)
- Modify: `packages/api/src/schema.ts` (add the two tables)
- Test: `packages/core/test/schema.test.ts` (constraints on the new tables)

**Interfaces:**
- Consumes: `locations`, `employees` (existing).
- Produces: `location_shift_slots` (location_id, slot_number, starts_at, ends_at; unique per location+slot) and `schedule_name_map` (source_name unique, employee_id nullable, ignored boolean) — consumed by Tasks 4–5.

- [ ] **Step 1: Write the migration**

`packages/core/db/migrations/0003_schedule_import.sql`:
```sql
-- Spreadsheet schedule import (design spec 5.1): slot windows per location, and a
-- persisted mapping from spreadsheet name-rows to employee records.

CREATE TABLE location_shift_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, slot_number),
  -- Same window rules as shifts: ordered, whole minutes, strictly before 24:00 so the
  -- 'HH:MM' API contract can round-trip the value.
  CONSTRAINT location_shift_slots_window_order CHECK (ends_at > starts_at),
  CONSTRAINT location_shift_slots_below_24 CHECK (starts_at < '24:00:00' AND ends_at < '24:00:00'),
  CONSTRAINT location_shift_slots_whole_minute CHECK (
    date_trunc('minute', starts_at::interval) = starts_at::interval
    AND date_trunc('minute', ends_at::interval) = ends_at::interval
  )
);

-- One row per distinct spreadsheet name. Either it maps to an employee, or it is marked
-- ignored (placeholder rows like 'Бариста 1'), never both.
CREATE TABLE schedule_name_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL UNIQUE,
  employee_id UUID REFERENCES employees (id) ON DELETE CASCADE,
  ignored BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_name_map_resolved CHECK (
    (employee_id IS NOT NULL AND ignored = FALSE)
    OR (employee_id IS NULL AND ignored = TRUE)
  )
);
```

- [ ] **Step 2: Register the migration**

In `packages/core/src/migrations.ts`, add the read and extend the ordered list:
```ts
/** The schedule-import migration. Node-only. */
export const SCHEDULE_IMPORT_SQL = read('0003_schedule_import.sql');
```
and update:
```ts
export const MIGRATIONS: string[] = [INIT_SQL, HOURS_MODEL_SQL, SCHEDULE_IMPORT_SQL];
```

- [ ] **Step 3: Add the Drizzle tables**

In `packages/api/src/schema.ts` (import `integer` from `drizzle-orm/pg-core`):
```ts
export const locationShiftSlots = pgTable(
  'location_shift_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    slotNumber: integer('slot_number').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.locationId, t.slotNumber)],
);

export const scheduleNameMap = pgTable('schedule_name_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceName: text('source_name').notNull().unique(),
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }),
  ignored: boolean('ignored').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add schema tests**

Append to `packages/core/test/schema.test.ts` (inside the existing describe that applies all
`MIGRATIONS`; reuse its `LOC`/`EMP` constants):
```ts
  it('stores a slot window and enforces one row per location-slot', async () => {
    await db.exec(
      `INSERT INTO location_shift_slots (location_id, slot_number, starts_at, ends_at)
       VALUES ('${LOC}', 1, '08:00', '14:00');`,
    );
    await expect(
      db.exec(
        `INSERT INTO location_shift_slots (location_id, slot_number, starts_at, ends_at)
         VALUES ('${LOC}', 1, '14:00', '20:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a slot window at 24:00 or with seconds', async () => {
    await expect(
      db.exec(
        `INSERT INTO location_shift_slots (location_id, slot_number, starts_at, ends_at)
         VALUES ('${LOC}', 8, '20:00', '24:00:00');`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `INSERT INTO location_shift_slots (location_id, slot_number, starts_at, ends_at)
         VALUES ('${LOC}', 9, '08:00:30', '14:00');`,
      ),
    ).rejects.toThrow();
  });

  it('maps a name to an employee or marks it ignored, never both', async () => {
    await db.exec(
      `INSERT INTO schedule_name_map (source_name, employee_id) VALUES ('Олег', '${EMP}');`,
    );
    await db.exec(
      `INSERT INTO schedule_name_map (source_name, ignored) VALUES ('Бариста 1', TRUE);`,
    );
    // Both set is contradictory.
    await expect(
      db.exec(
        `INSERT INTO schedule_name_map (source_name, employee_id, ignored)
         VALUES ('Bad', '${EMP}', TRUE);`,
      ),
    ).rejects.toThrow();
    // Neither set resolves nothing.
    await expect(
      db.exec(`INSERT INTO schedule_name_map (source_name) VALUES ('Unresolved');`),
    ).rejects.toThrow();
  });

  it('enforces one mapping row per source name', async () => {
    await db.exec(`INSERT INTO schedule_name_map (source_name, ignored) VALUES ('Dup', TRUE);`);
    await expect(
      db.exec(`INSERT INTO schedule_name_map (source_name, ignored) VALUES ('Dup', TRUE);`),
    ).rejects.toThrow();
  });
```

- [ ] **Step 5: Run both suites**

Run: `pnpm --filter @salary/core test && pnpm --filter @salary/api test`
Then: `pnpm -r typecheck`
Expected: all green. The API suite must still pass — `createTestDb` applies `MIGRATIONS`, so
the new tables appear automatically.

- [ ] **Step 6: Commit**

```bash
git add packages/core/db/migrations/0003_schedule_import.sql packages/core/src/migrations.ts packages/core/test/schema.test.ts packages/api/src/schema.ts
git commit -m "Add slot-window and schedule name-map tables"
```

---

### Task 4: Slot-window and name-map API routes

**Files:**
- Create: `packages/api/src/routes/shiftSlots.ts`
- Create: `packages/api/src/routes/scheduleNameMap.ts`
- Modify: `packages/api/src/app.ts` (mount both)
- Test: `packages/api/test/shift-slots.test.ts`
- Test: `packages/api/test/schedule-name-map.test.ts`

**Interfaces:**
- Consumes: `Db`, `requireRole`, `readJson`/`getOr404`, `isUniqueViolation`, the Task 3 tables.
- Produces:
  - `createShiftSlotRoutes(db)` at `/api/locations/:locationId/slots` — admin CRUD (`GET /`, `PUT /:slotNumber` upsert, `DELETE /:slotNumber`). DTO `{ locationId, slotNumber, startsAt, endsAt }`.
  - `createScheduleNameMapRoutes(db)` at `/api/schedule-name-map` — manager/admin (`GET /`, `PUT /` upsert one mapping, `DELETE /:sourceName`). DTO `{ sourceName, employeeId, ignored }`.

- [ ] **Step 1: Write the failing slot-routes test**

`packages/api/test/shift-slots.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { locations } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'admin') return { sub: 'u-admin', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    throw new Error('bad');
  },
};
const ADMIN = { Authorization: 'Bearer admin' };
const MGR = { Authorization: 'Bearer mgr' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [loc] = await db
    .insert(locations)
    .values({ name: 'A', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  return { app: createApp({ db, verifier }), loc };
}

describe('location shift slots', () => {
  it('forbids a manager from configuring slots (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(res.status).toBe(403);
  });

  it('creates, lists, and updates a slot window', async () => {
    const { app, loc } = await seed();
    const created = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ slotNumber: 1, startsAt: '08:00', endsAt: '14:00' });

    // PUT is an upsert: the same slot number replaces the window.
    const updated = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '09:00', endsAt: '15:00' }),
    });
    expect((await updated.json()).startsAt).toBe('09:00');

    await app.request(`/api/locations/${loc.id}/slots/2`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '14:00', endsAt: '20:00' }),
    });
    const list = await app.request(`/api/locations/${loc.id}/slots`, { headers: ADMIN });
    expect(await list.json()).toHaveLength(2);
  });

  it('rejects an inverted or malformed window (400)', async () => {
    const { app, loc } = await seed();
    const inverted = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '14:00', endsAt: '08:00' }),
    });
    expect(inverted.status).toBe(400);
    const malformed = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '8:00', endsAt: '14:00' }),
    });
    expect(malformed.status).toBe(400);
  });

  it('rejects a slot window outside the location hours (400)', async () => {
    const { app, loc } = await seed(); // location A opens 08:00, closes 20:00
    const tooEarly = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '06:00', endsAt: '07:00' }),
    });
    expect(tooEarly.status).toBe(400);
    const tooLate = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '19:00', endsAt: '23:00' }),
    });
    expect(tooLate.status).toBe(400);
    // Exactly matching the location hours is allowed.
    const exact = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '20:00' }),
    });
    expect(exact.status).toBe(200);
  });

  it('400s an unknown location and 404s a bad slot number', async () => {
    const { app, loc } = await seed();
    const badLoc = await app.request('/api/locations/00000000-0000-0000-0000-000000000000/slots/1', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(badLoc.status).toBe(400);
    const badSlot = await app.request(`/api/locations/${loc.id}/slots/0`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(badSlot.status).toBe(400);
  });

  it('deletes a slot', async () => {
    const { app, loc } = await seed();
    await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    const del = await app.request(`/api/locations/${loc.id}/slots/1`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);
    expect((await (await app.request(`/api/locations/${loc.id}/slots`, { headers: ADMIN })).json())).toHaveLength(0);
    const again = await app.request(`/api/locations/${loc.id}/slots/1`, { method: 'DELETE', headers: ADMIN });
    expect(again.status).toBe(404);
  });
});
```

- [ ] **Step 2: Write the failing name-map test**

`packages/api/test/schedule-name-map.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [alice] = await db.insert(employees).values({ name: 'Alice', levelId: level.id }).returning();
  return { app: createApp({ db, verifier }), alice };
}

describe('schedule name map', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/schedule-name-map', { headers: EMP })).status).toBe(403);
  });

  it('maps a source name to an employee and lists it', async () => {
    const { app, alice } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Олег', employeeId: alice.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceName: 'Олег', employeeId: alice.id, ignored: false });
    const list = await app.request('/api/schedule-name-map', { headers: MGR });
    expect(await list.json()).toHaveLength(1);
  });

  it('marks a placeholder row ignored', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Бариста 1', ignored: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true, employeeId: null });
  });

  it('rejects a mapping that is neither resolved nor ignored (400)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Nobody' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects both employeeId and ignored together (400)', async () => {
    const { app, alice } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Both', employeeId: alice.id, ignored: true }),
    });
    expect(res.status).toBe(400);
  });

  it('400s an unknown employeeId', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Ghost', employeeId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(400);
  });

  it('re-mapping the same source name replaces it', async () => {
    const { app, alice } = await seed();
    const body = JSON.stringify({ sourceName: 'Олег', employeeId: alice.id });
    await app.request('/api/schedule-name-map', { method: 'PUT', headers: { ...MGR, ...JSONH }, body });
    const again = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Олег', ignored: true }),
    });
    expect(again.status).toBe(200);
    expect((await (await app.request('/api/schedule-name-map', { headers: MGR })).json())).toHaveLength(1);
  });

  it('deletes a mapping', async () => {
    const { app } = await seed();
    await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Temp', ignored: true }),
    });
    const del = await app.request('/api/schedule-name-map/Temp', { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
    expect((await app.request('/api/schedule-name-map/Temp', { method: 'DELETE', headers: MGR })).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter @salary/api test shift-slots` and `pnpm --filter @salary/api test schedule-name-map`
Expected: FAIL — the route modules do not exist and nothing is mounted.

- [ ] **Step 4: Implement the slot routes**

`packages/api/src/routes/shiftSlots.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { locationShiftSlots, locations } from '../schema';

const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be HH:MM (24-hour)');
const windowSchema = z
  .object({ startsAt: timeString, endsAt: timeString })
  .refine((v) => v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt' });

type SlotRow = typeof locationShiftSlots.$inferSelect;
function toDto(row: SlotRow) {
  return {
    locationId: row.locationId,
    slotNumber: row.slotNumber,
    startsAt: row.startsAt.slice(0, 5),
    endsAt: row.endsAt.slice(0, 5),
  };
}

export function createShiftSlotRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('admin'));

  async function requireLocation(locationId: string): Promise<void> {
    if (!z.string().uuid().safeParse(locationId).success) {
      throw new HTTPException(400, { message: 'invalid locationId' });
    }
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
  }

  function slotNumberParam(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new HTTPException(400, { message: 'slot number must be a positive integer' });
    }
    return n;
  }

  routes.get('/', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const rows = await db
      .select()
      .from(locationShiftSlots)
      .where(eq(locationShiftSlots.locationId, locationId));
    return c.json(rows.map(toDto));
  });

  /**
   * A slot window must fall inside the location's own working hours — otherwise the
   * importer would happily produce shifts for hours the shop is shut. The DB constrains
   * the window's shape (ordered, whole minutes, < 24:00) but cannot compare it to the
   * parent location's hours, so it is enforced here.
   */
  async function assertWithinLocationHours(
    locationId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<void> {
    const [location] = await db.select().from(locations).where(eq(locations.id, locationId));
    const opensAt = location.opensAt.slice(0, 5);
    const closesAt = location.closesAt.slice(0, 5);
    if (startsAt < opensAt || endsAt > closesAt) {
      throw new HTTPException(400, {
        message: `slot window must fall within the location hours ${opensAt}-${closesAt}`,
      });
    }
  }

  // PUT is an upsert so re-configuring a slot is idempotent.
  routes.put('/:slotNumber', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const slotNumber = slotNumberParam(c.req.param('slotNumber')!);
    const body = await readJson(c, windowSchema);
    await assertWithinLocationHours(locationId, body.startsAt, body.endsAt);
    const [row] = await db
      .insert(locationShiftSlots)
      .values({ locationId, slotNumber, startsAt: body.startsAt, endsAt: body.endsAt })
      .onConflictDoUpdate({
        target: [locationShiftSlots.locationId, locationShiftSlots.slotNumber],
        set: { startsAt: body.startsAt, endsAt: body.endsAt },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/:slotNumber', async (c) => {
    const locationId = c.req.param('locationId')!;
    await requireLocation(locationId);
    const slotNumber = slotNumberParam(c.req.param('slotNumber')!);
    const [row] = await db
      .delete(locationShiftSlots)
      .where(
        and(eq(locationShiftSlots.locationId, locationId), eq(locationShiftSlots.slotNumber, slotNumber)),
      )
      .returning();
    if (!row) throw new HTTPException(404, { message: 'slot not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
```

- [ ] **Step 5: Implement the name-map routes**

`packages/api/src/routes/scheduleNameMap.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { scheduleNameMap, employees } from '../schema';

// A mapping either points at an employee or is explicitly ignored — never both, never
// neither, so a name can't silently resolve to nobody at import time.
const upsertSchema = z
  .object({
    sourceName: z.string().min(1),
    employeeId: z.string().uuid().optional(),
    ignored: z.boolean().optional(),
  })
  .refine((v) => (v.employeeId !== undefined) !== (v.ignored === true), {
    message: 'provide exactly one of employeeId or ignored: true',
  });

type MapRow = typeof scheduleNameMap.$inferSelect;
function toDto(row: MapRow) {
  return { sourceName: row.sourceName, employeeId: row.employeeId, ignored: row.ignored };
}

export function createScheduleNameMapRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(scheduleNameMap);
    return c.json(rows.map(toDto));
  });

  routes.put('/', async (c) => {
    const body = await readJson(c, upsertSchema);
    if (body.employeeId !== undefined) {
      const emp = await db.select().from(employees).where(eq(employees.id, body.employeeId));
      if (emp.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
    }
    const values = {
      sourceName: body.sourceName,
      employeeId: body.employeeId ?? null,
      ignored: body.ignored ?? false,
    };
    const [row] = await db
      .insert(scheduleNameMap)
      .values(values)
      .onConflictDoUpdate({
        target: scheduleNameMap.sourceName,
        set: { employeeId: values.employeeId, ignored: values.ignored },
      })
      .returning();
    return c.json(toDto(row));
  });

  routes.delete('/:sourceName', async (c) => {
    const [row] = await db
      .delete(scheduleNameMap)
      .where(eq(scheduleNameMap.sourceName, c.req.param('sourceName')!))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'mapping not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
```

- [ ] **Step 6: Mount both**

In `packages/api/src/app.ts`, add the imports:
```ts
import { createShiftSlotRoutes } from './routes/shiftSlots';
import { createScheduleNameMapRoutes } from './routes/scheduleNameMap';
```
and mount them after the existing route groups:
```ts
  app.route('/api/locations/:locationId/slots', createShiftSlotRoutes(deps.db));
  app.route('/api/schedule-name-map', createScheduleNameMapRoutes(deps.db));
```
Note: the slot routes read `c.req.param('locationId')` from the mount path — verify the
`/api/locations/:locationId/slots` prefix does not shadow the existing
`/api/locations/:id` routes. If the locations suite starts failing, mount the slots at a
non-nested path (`/api/location-slots/:locationId`) instead, adjust the test URLs, and note
the change in the report. The tests are the arbiter.

- [ ] **Step 7: Run both suites**

Run: `pnpm --filter @salary/api test`
Then: `pnpm --filter @salary/api typecheck`
Expected: PASS — the new suites green and every existing API test still green.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/shiftSlots.ts packages/api/src/routes/scheduleNameMap.ts packages/api/src/app.ts packages/api/test/shift-slots.test.ts packages/api/test/schedule-name-map.test.ts
git commit -m "Add slot-window and schedule name-map routes"
```

---

### Task 5: Import preview and commit endpoints

**Files:**
- Create: `packages/api/src/routes/scheduleImports.ts`
- Modify: `packages/api/src/app.ts` (mount)
- Modify: `packages/api/package.json` (add `exceljs` dependency)
- Test: `packages/api/test/schedule-import.test.ts`

**Interfaces:**
- Consumes: `parseScheduleGrid` (Task 2), the slot/name-map tables (Task 3), `locations`, `shifts`.
- Produces: `createScheduleImportRoutes(db)` at `/api/schedule-imports`, manager/admin:
  - `POST /preview` — multipart `.xlsx` upload + `{ year }`; parses, resolves names/slots/locations, returns `{ months, resolved, unmappedNames, missingSlots, unknownLocations, anomalies }` and writes NOTHING.
  - `POST /commit` — same upload plus `{ year, month, half? }`; writes the resolved shifts for that period as `source='imported'`, `status='approved'`, skipping rows that already exist; returns `{ created, skipped, conflicts }`.

- [ ] **Step 1: Add the exceljs dependency**

In `packages/api/package.json`, add to `dependencies`:
```json
    "exceljs": "^4.4.0",
```
Run: `pnpm install`

- [ ] **Step 2: Write the failing import test**

`packages/api/test/schedule-import.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, locationShiftSlots, scheduleNameMap, shifts } from '../src/schema';
import { makeScheduleWorkbookBuffer } from '../../core/test/fixtures/makeScheduleFixture';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };

/** Build the multipart body the endpoints expect. */
async function form(fields: Record<string, string>): Promise<FormData> {
  const fd = new FormData();
  const buf = await makeScheduleWorkbookBuffer();
  fd.set(
    'file',
    new File([new Uint8Array(buf)], 'schedule.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Location "1" and "2" plus slot windows and a name mapping for Олег. */
async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc1] = await db.insert(locations).values({ name: '1', opensAt: '08:00', closesAt: '20:00' }).returning();
  const [loc2] = await db.insert(locations).values({ name: '2', opensAt: '08:00', closesAt: '20:00' }).returning();
  const [oleg] = await db.insert(employees).values({ name: 'Oleg', levelId: level.id }).returning();
  for (const loc of [loc1, loc2]) {
    await db.insert(locationShiftSlots).values([
      { locationId: loc.id, slotNumber: 1, startsAt: '08:00', endsAt: '14:00' },
      { locationId: loc.id, slotNumber: 2, startsAt: '14:00', endsAt: '20:00' },
    ]);
  }
  await db.insert(scheduleNameMap).values({ sourceName: 'Олег', employeeId: oleg.id });
  return { db, app: createApp({ db, verifier }), loc1, loc2, oleg };
}

describe('schedule import', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer emp' },
      body: await form({ year: '2026' }),
    });
    expect(res.status).toBe(403);
  });

  it('previews without writing anything', async () => {
    const { db, app } = await seed();
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.months).toEqual(expect.arrayContaining([{ year: 2026, month: 5 }]));
    // Олег is mapped; Марта/Тарас/Бариста 1 are not.
    expect(body.unmappedNames).toEqual(expect.arrayContaining(['Марта', 'Тарас', 'Бариста 1']));
    expect(body.resolved.length).toBeGreaterThan(0);
    expect(body.anomalies.length).toBeGreaterThan(0);
    // Nothing persisted.
    expect(await db.select().from(shifts)).toHaveLength(0);
  });

  it('reports a location number with no matching location', async () => {
    const { app } = await seed(); // fixture references location 3 in slot 2; only 1 and 2 exist
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    expect((await res.json()).unknownLocations).toEqual(expect.arrayContaining([3]));
  });

  it('commits only the requested month as imported approved shifts', async () => {
    const { db, app, oleg } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBeGreaterThan(0);

    const rows = await db.select().from(shifts);
    expect(rows.length).toBe(body.created);
    for (const row of rows) {
      expect(row.source).toBe('imported');
      expect(row.status).toBe('approved');
      expect(row.employeeId).toBe(oleg.id); // only Олег is mapped
      expect(row.workDate.startsWith('2026-05')).toBe(true); // June not committed
    }
    // Slot 1 window came from location_shift_slots.
    expect(rows[0].startsAt.slice(0, 5)).toBe('08:00');
  });

  it('is idempotent: re-committing skips existing shifts', async () => {
    const { app } = await seed();
    const first = await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json();
    const second = await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(first.created);
  });

  it('400s a missing file or invalid year', async () => {
    const { app } = await seed();
    const noFile = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: (() => {
        const fd = new FormData();
        fd.set('year', '2026');
        return fd;
      })(),
    });
    expect(noFile.status).toBe(400);
    const badYear = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: 'nope' }),
    });
    expect(badYear.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test schedule-import`
Expected: FAIL — the route module does not exist.

- [ ] **Step 4: Implement the import routes**

`packages/api/src/routes/scheduleImports.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { parseScheduleGrid, type ParsedShiftCell } from '@salary/core';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { isUniqueViolation } from '../http/dbErrors';
import { locations, locationShiftSlots, scheduleNameMap, shifts } from '../schema';

const SHEET_NAME = 'Графік роботи';

interface ResolvedShift {
  employeeId: string;
  locationId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  sourceName: string;
  slot: number;
  locationNumber: number;
}

export function createScheduleImportRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  /** Read the uploaded workbook's schedule sheet into the parser's row-major grid. */
  async function gridFromUpload(c: Parameters<Parameters<typeof routes.post>[1]>[0]) {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'file is required' });
    const year = Number(String(body['year'] ?? ''));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new HTTPException(400, { message: 'year must be an integer between 2000 and 2100' });
    }
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(await file.arrayBuffer());
    } catch {
      throw new HTTPException(400, { message: 'could not read the workbook' });
    }
    const ws = wb.getWorksheet(SHEET_NAME);
    if (!ws) throw new HTTPException(400, { message: `sheet "${SHEET_NAME}" not found` });
    const grid: (string | number | null)[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row: (string | number | null)[] = [];
      for (let col = 1; col <= ws.columnCount; col++) {
        const v = ws.getCell(r, col).value;
        row.push(v === null || v === undefined ? null : (v as string | number));
      }
      grid.push(row);
    }
    return { grid, year, body };
  }

  /**
   * Turn parsed cells into concrete shifts, reporting everything that could not be
   * resolved instead of guessing. A name with no mapping, a location number with no
   * location, or a (location, slot) with no window is reported, never invented.
   */
  async function resolve(cells: ParsedShiftCell[]) {
    const [locs, slots, mappings] = await Promise.all([
      db.select().from(locations),
      db.select().from(locationShiftSlots),
      db.select().from(scheduleNameMap),
    ]);
    // Locations are matched by name, which is how the sheet refers to them (a number).
    const locationByName = new Map(locs.map((l) => [l.name.trim(), l]));
    const slotKey = (locationId: string, slot: number) => `${locationId}|${slot}`;
    const slotByKey = new Map(slots.map((s) => [slotKey(s.locationId, s.slotNumber), s]));
    const mapByName = new Map(mappings.map((m) => [m.sourceName, m]));

    const resolved: ResolvedShift[] = [];
    const unmappedNames = new Set<string>();
    const unknownLocations = new Set<number>();
    const missingSlots = new Set<string>();

    for (const cell of cells) {
      const mapping = mapByName.get(cell.sourceName);
      if (!mapping) {
        unmappedNames.add(cell.sourceName);
        continue;
      }
      if (mapping.ignored || mapping.employeeId === null) continue;

      const location = locationByName.get(String(cell.locationNumber));
      if (!location) {
        unknownLocations.add(cell.locationNumber);
        continue;
      }
      const slot = slotByKey.get(slotKey(location.id, cell.slot));
      if (!slot) {
        missingSlots.add(`${location.name}:${cell.slot}`);
        continue;
      }
      resolved.push({
        employeeId: mapping.employeeId,
        locationId: location.id,
        workDate: cell.date,
        startsAt: slot.startsAt.slice(0, 5),
        endsAt: slot.endsAt.slice(0, 5),
        sourceName: cell.sourceName,
        slot: cell.slot,
        locationNumber: cell.locationNumber,
      });
    }

    return {
      resolved,
      unmappedNames: [...unmappedNames],
      unknownLocations: [...unknownLocations],
      missingSlots: [...missingSlots],
    };
  }

  routes.post('/preview', async (c) => {
    const { grid, year } = await gridFromUpload(c);
    const parsed = parseScheduleGrid(grid, { year });
    const resolution = await resolve(parsed.cells);
    return c.json({
      months: parsed.months,
      sourceNames: parsed.sourceNames,
      anomalies: parsed.anomalies,
      ...resolution,
    });
  });

  routes.post('/commit', async (c) => {
    const { grid, year, body } = await gridFromUpload(c);
    const month = Number(String(body['month'] ?? ''));
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new HTTPException(400, { message: 'month must be an integer between 1 and 12' });
    }
    const parsed = parseScheduleGrid(grid, { year });
    const inMonth = parsed.cells.filter((cell) => cell.month === month);
    const { resolved, unmappedNames, unknownLocations, missingSlots } = await resolve(inMonth);

    let created = 0;
    let skipped = 0;
    const conflicts: string[] = [];

    for (const shift of resolved) {
      // Already imported (or otherwise present) for this employee/date/location/window.
      const existing = await db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.employeeId, shift.employeeId),
            eq(shifts.workDate, shift.workDate),
            eq(shifts.locationId, shift.locationId),
            eq(shifts.startsAt, shift.startsAt),
          ),
        );
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }
      try {
        await db.insert(shifts).values({
          employeeId: shift.employeeId,
          locationId: shift.locationId,
          workDate: shift.workDate,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          status: 'approved',
          source: 'imported',
        });
        created += 1;
      } catch (err) {
        if (isUniqueViolation(err)) {
          skipped += 1;
          continue;
        }
        conflicts.push(`${shift.sourceName} ${shift.workDate} slot ${shift.slot}`);
      }
    }

    return c.json({
      period: { year, month },
      created,
      skipped,
      conflicts,
      unmappedNames,
      unknownLocations,
      missingSlots,
    });
  });

  return routes;
}
```

Note on overlap: the commit path inserts directly and relies on the DB's composite UNIQUE
plus the pre-check above for idempotency. It does NOT run the API's `assertNoOverlap`, so an
imported shift could overlap a differently-timed approved shift. Task 6 addresses that
explicitly — do not add it here.

- [ ] **Step 5: Mount the routes**

In `packages/api/src/app.ts`:
```ts
import { createScheduleImportRoutes } from './routes/scheduleImports';
```
```ts
  app.route('/api/schedule-imports', createScheduleImportRoutes(deps.db));
```

- [ ] **Step 6: Run the suites**

Run: `pnpm --filter @salary/api test`
Then: `pnpm -r typecheck`
Expected: PASS — import tests green, all existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/scheduleImports.ts packages/api/src/app.ts packages/api/package.json packages/api/test/schedule-import.test.ts pnpm-lock.yaml
git commit -m "Add schedule import preview and commit endpoints"
```

---

### Task 6: Reject overlapping imports

**Files:**
- Modify: `packages/api/src/routes/scheduleImports.ts` (overlap check before insert)
- Modify: `packages/api/test/schedule-import.test.ts` (overlap coverage)

**Interfaces:**
- Consumes: the commit path (Task 5).
- Produces: no signature change; `conflicts` now reports overlapping rows that were not written.

An imported shift must obey the same rule as every other approved shift: one employee cannot
hold two overlapping approved shifts across ANY location. Without this, an import silently
inflates the proration denominator and underpays coworkers — the exact defect a prior review
caught in the manager routes.

- [ ] **Step 1: Add the failing overlap test**

Append to `packages/api/test/schedule-import.test.ts` (inside the describe):
```ts
  it('does not write an imported shift that overlaps an existing approved shift', async () => {
    const { db, app, loc2, oleg } = await seed();
    // Олег already works 09:00-15:00 at another location on a day the sheet schedules him.
    await db.insert(shifts).values({
      employeeId: oleg.id,
      locationId: loc2.id,
      workDate: '2026-05-01',
      startsAt: '09:00',
      endsAt: '15:00',
      status: 'approved',
      source: 'native',
    });

    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflicts.length).toBeGreaterThan(0);

    // The overlapping day was not written; the pre-existing shift is untouched.
    const onDay = await db.select().from(shifts).where(eq(shifts.workDate, '2026-05-01'));
    expect(onDay).toHaveLength(1);
    expect(onDay[0].source).toBe('native');
  });
```
Add `eq` to the test file's drizzle import.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @salary/api test schedule-import`
Expected: FAIL — the overlapping shift is currently written, so the day has 2 rows and
`conflicts` is empty.

- [ ] **Step 3: Add the overlap check**

In `packages/api/src/routes/scheduleImports.ts`, add a helper inside
`createScheduleImportRoutes`:
```ts
  /**
   * A person cannot be in two places at once: reject an imported window that overlaps an
   * existing approved shift for that employee on that date, at ANY location. Half-open, so
   * touching windows (08:00-14:00 then 14:00-20:00) are fine.
   */
  async function overlapsApproved(
    employeeId: string,
    workDate: string,
    startsAt: string,
    endsAt: string,
  ): Promise<boolean> {
    const sameDay = await db
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.employeeId, employeeId),
          eq(shifts.workDate, workDate),
          eq(shifts.status, 'approved'),
        ),
      );
    return sameDay.some(
      (s) => startsAt < s.endsAt.slice(0, 5) && s.startsAt.slice(0, 5) < endsAt,
    );
  }
```
Then in the commit loop, after the existing-row check and before the insert:
```ts
      if (await overlapsApproved(shift.employeeId, shift.workDate, shift.startsAt, shift.endsAt)) {
        conflicts.push(
          `${shift.sourceName} ${shift.workDate} slot ${shift.slot}: overlaps an approved shift`,
        );
        continue;
      }
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @salary/api test schedule-import`
Then: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — the overlap test green (conflict reported, nothing written) and the whole
workspace green.

Sanity-check the test is meaningful: temporarily comment out the `overlapsApproved` guard and
confirm the new test fails; restore it. Report the result.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/scheduleImports.ts packages/api/test/schedule-import.test.ts
git commit -m "Reject imported shifts that overlap approved shifts"
```

---

## Self-Review

**Spec coverage (§5.1):**
- Horizontal months, weekday+day header rows, slot blocks, location-number cells → Task 2 (parser) with Task 1's fixture reproducing each quirk.
- Trailing shift-count total column ignored → Task 2 (day columns require a weekday label above them) + explicit test.
- Substitute-name cells and annotation rows reported, not dropped → Task 2 (`anomalies`).
- Slot times per location → Task 3 (`location_shift_slots`) + Task 4 (admin routes) + Task 5 (resolution).
- Name mapping confirmed once and persisted; placeholders ignorable; never guesses → Task 3 (`schedule_name_map` with the resolved-XOR-ignored constraint) + Task 4 (routes) + Task 5 (`unmappedNames`).
- Manager picks the period → Task 5 (`preview` parses all, `commit` filters by month).
- `source='imported'` + overlap rule → Task 5 (insert) + Task 6 (overlap rejection).

**Placeholder scan:** No TBD/TODO. Two contingencies are explicit and test-arbitrated: the
nested `/api/locations/:locationId/slots` mount possibly shadowing `/api/locations/:id`
(Task 4 Step 6), and the fixture-vs-real-layout tie-break (Task 2 Step 5).

**Type consistency:** the parser is pure and grid-based (`(string|number|null)[][]`), so
`exceljs` stays out of `@salary/core`'s runtime deps and lives only in `@salary/api` plus
core's devDependencies; `ParsedShiftCell.date` is `'YYYY-MM-DD'` matching `shifts.workDate`;
all times cross boundaries as `'HH:MM'` via `.slice(0, 5)`, consistent with the hours-model
convention; `location_shift_slots` carries the same window constraints as `shifts` so a slot
can never produce an unstorable shift.

**Known limitation (deliberate, not a gap):** locations are matched to the sheet's numbers by
`locations.name` (the sheet calls them `1`–`5`). If the business renames a location to
something non-numeric, imports report it under `unknownLocations` rather than failing
silently — visible and fixable, and cheaper than adding a separate mapping table now.

---

## Post-Review Fixes (final review returned "No — with fixes")

Two Critical defects, both verified by running the parser, both reachable on the first real
upload, and both originating in this plan's own reference code:

1. **CRITICAL — a formatted cell crashes the parser (opaque 500).** The `(v as string | number)`
   cast when reading the worksheet lets 4 of exceljs's 10 `CellValue` variants (rich text,
   formula, `Date`, boolean) reach `asNumber`'s `.trim()`, which throws a `TypeError` — not an
   `HTTPException`, so it surfaces as `{error:'internal'}` 500 with no indication of which cell
   broke. Hand-edited cells are the ones that pick up bold/colour formatting, so the substitute
   names (`Сві`, `Хри`, `Вла`) are the most likely to hit it. Fix: a `flatten(v: ExcelJS.CellValue)`
   boundary helper that reduces every variant to `string | number | null`, plus making
   `asNumber` total (`value: unknown`, return `null` for non-strings) so the parser cannot throw
   regardless of caller.
2. **CRITICAL — day 31 in a 30-day month emits an invalid date.** The day guard was the purely
   syntactic `day >= 1 && day <= 31`, so a stale day-31 column in a 30-day month block (common
   when a block is copy-pasted) produced `'2026-06-31'` as a clean shift with ZERO anomalies.
   Postgres then rejects it, and because that is not a unique violation it lands in the generic
   catch and is reported to the manager as an *overlap conflict* — a misleading diagnosis for a
   malformed source cell. February hits this every import. Fix: validate the day against the
   real length of its attributed month in the parser and report an `unparsed` anomaly instead of
   emitting a cell. This also gives the `'unparsed'` anomaly kind its first use — it was declared
   and never emitted.
3. **IMPORTANT — a rich-text NAME cell silently deletes that person's month** (same root cause as
   #1): `nameFromRow` returns null and `nameCellBlank` is false, so every location number on the
   row is filed as a nameless `substitute` and the name never reaches `sourceNames`, so the
   manager is never prompted to map it. Fixed by the same `flatten` helper.
4. **IMPORTANT — an inactive employee's imported hours dilute coworkers' pay.** `resolve()` never
   consulted `employees.active`. `calculateSalaries` skips inactive employees for *payment* but
   still counts their shifts in the pass-1 proration denominator, so importing shifts for a
   departed employee silently reduces every active coworker's revenue share on those
   location-days. Fix: report such mappings in an `inactiveEmployees` array instead of resolving
   them.
5. **IMPORTANT — idempotency probe ignored `endsAt`.** If an admin narrows a slot window and the
   manager re-imports, the probe matched the stale row on `startsAt` alone, counted it `skipped`,
   and left the OLD longer window in place — overpaying that employee and diluting coworkers.
   Fix: include `endsAt` in the probe and report a mismatch in a distinct `windowChanged` array
   rather than folding it into `skipped`.
6. **MINOR — a dead assertion.** `expect(...locationNumber === Number.NaN).toBe(false)` is
   vacuous (`NaN === NaN` is always false); use `Number.isNaN`.

**Structural lesson (why the tests missed all of this):** the fixture can only emit the cell
types exceljs *writes*, never the hostile types it *reads*. Adversarial inputs belong in direct
unit tests of `parseScheduleGrid`, which takes a plain array and needs no workbook at all.
