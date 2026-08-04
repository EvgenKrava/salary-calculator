import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from '../src/migrations';

const LEVEL = '11111111-1111-1111-1111-111111111111';
const LOC = '22222222-2222-2222-2222-222222222222';
const EMP = '33333333-3333-3333-3333-333333333333';

describe('schema 0001_init + 0002_hours_model', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const sql of MIGRATIONS) {
      await db.exec(sql);
    }
    await db.exec(`
      INSERT INTO levels (id, name, rate_per_hour) VALUES ('${LEVEL}', 'Junior', 20.00);
      INSERT INTO locations (id, name, opens_at, closes_at) VALUES ('${LOC}', 'Downtown', '08:00', '20:00');
      INSERT INTO employees (id, name, level_id, revenue_percent)
        VALUES ('${EMP}', 'Alice', '${LEVEL}', 0.0500);
    `);
  });

  it('stores and reads a shift', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-08-03', '08:00', '16:00');`,
    );
    const res = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM shifts;');
    expect(res.rows[0].count).toBe('1');
  });

  it('allows an employee two shifts in a day at different times', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-02', '08:00', '12:00');`,
    );
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-02', '13:00', '17:00');`,
    );
    const res = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM shifts WHERE work_date = '2026-09-02';`,
    );
    expect(res.rows[0].count).toBe('2');
  });

  it('still rejects an exact duplicate shift window', async () => {
    await db.exec(
      `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
       VALUES ('${EMP}', '${LOC}', '2026-09-03', '08:00', '12:00');`,
    );
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-03', '08:00', '12:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a shift whose end is not after its start', async () => {
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-04', '12:00', '08:00');`,
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

  it('rejects a location with closes_at not after opens_at', async () => {
    await expect(
      db.exec(
        `INSERT INTO locations (name, opens_at, closes_at) VALUES ('Bad Loc', '20:00', '08:00');`,
      ),
    ).rejects.toThrow();
  });
});
