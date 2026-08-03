import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../db/migrations/0001_init.sql'), 'utf8');

const LEVEL = '11111111-1111-1111-1111-111111111111';
const LOC = '22222222-2222-2222-2222-222222222222';
const EMP = '33333333-3333-3333-3333-333333333333';

describe('schema 0001_init', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(migration);
    await db.exec(`
      INSERT INTO levels (id, name, rate_per_hour) VALUES ('${LEVEL}', 'Junior', 20.00);
      INSERT INTO locations (id, name, standard_shift_hours) VALUES ('${LOC}', 'Downtown', 8.00);
      INSERT INTO employees (id, name, level_id, revenue_percent)
        VALUES ('${EMP}', 'Alice', '${LEVEL}', 0.0500);
    `);
  });

  it('stores and reads a shift', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${EMP}', '${LOC}', '2026-08-03');`,
    );
    const res = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM shifts;');
    expect(res.rows[0].count).toBe('1');
  });

  it('enforces one shift per employee per day', async () => {
    // Self-contained: seed and duplicate on a date no other test touches.
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${EMP}', '${LOC}', '2026-09-01');`,
    );
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${EMP}', '${LOC}', '2026-09-01');`,
      ),
    ).rejects.toThrow();
  });

  it('enforces one revenue row per location per day', async () => {
    await db.exec(
      `INSERT INTO daily_revenue (location_id, revenue_date, amount) VALUES ('${LOC}', '2026-08-03', 1000.00);`,
    );
    await expect(
      db.exec(
        `INSERT INTO daily_revenue (location_id, revenue_date, amount) VALUES ('${LOC}', '2026-08-03', 500.00);`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a revenue_percent above 1', async () => {
    await expect(
      db.exec(
        `INSERT INTO employees (name, level_id, revenue_percent) VALUES ('Bad', '${LEVEL}', 1.5);`,
      ),
    ).rejects.toThrow();
  });
});