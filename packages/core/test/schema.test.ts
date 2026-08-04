import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS, INIT_SQL, HOURS_MODEL_SQL } from '../src/migrations';

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

  it('rejects a shift window with sub-minute seconds', async () => {
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-05', '08:00:30', '16:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a location with a seconds-bearing window', async () => {
    await expect(
      db.exec(
        `INSERT INTO locations (name, opens_at, closes_at) VALUES ('Seconds Loc', '08:00:30', '16:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a shift window at 24:00', async () => {
    await expect(
      db.exec(
        `INSERT INTO shifts (employee_id, location_id, work_date, starts_at, ends_at)
         VALUES ('${EMP}', '${LOC}', '2026-09-06', '20:00', '24:00:00');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a location window at 24:00', async () => {
    await expect(
      db.exec(
        `INSERT INTO locations (name, opens_at, closes_at) VALUES ('Midnight Loc', '08:00', '24:00:00');`,
      ),
    ).rejects.toThrow();
  });
});

describe('0002_hours_model migration preserves real shift length', () => {
  it('derives closes_at from standard_shift_hours instead of defaulting to a flat window', async () => {
    // A fresh PGlite instance so 0001 and the pre-migration insert happen BEFORE 0002
    // runs — the shared `db` above already has 0002 applied, so it cannot exercise the
    // old-model round-trip this regression guards against.
    const oldModelDb = new PGlite();
    await oldModelDb.exec(INIT_SQL);

    const level = '44444444-4444-4444-4444-444444444444';
    const loc = '55555555-5555-5555-5555-555555555555';
    const emp = '66666666-6666-6666-6666-666666666666';
    await oldModelDb.exec(`
      INSERT INTO levels (id, name, rate_per_hour) VALUES ('${level}', 'Junior', 20.00);
      INSERT INTO locations (id, name, standard_shift_hours) VALUES ('${loc}', 'Uptown', 6.00);
      INSERT INTO employees (id, name, level_id, revenue_percent) VALUES ('${emp}', 'Bob', '${level}', 0.05);
      INSERT INTO shifts (employee_id, location_id, work_date) VALUES ('${emp}', '${loc}', '2026-08-03');
    `);

    await oldModelDb.exec(HOURS_MODEL_SQL);

    const locRes = await oldModelDb.query<{ opens_at: string; closes_at: string }>(
      `SELECT opens_at, closes_at FROM locations WHERE id = '${loc}';`,
    );
    expect(locRes.rows[0].opens_at).toBe('08:00:00');
    expect(locRes.rows[0].closes_at).toBe('14:00:00');

    const shiftRes = await oldModelDb.query<{ starts_at: string; ends_at: string }>(
      `SELECT starts_at, ends_at FROM shifts WHERE location_id = '${loc}';`,
    );
    expect(shiftRes.rows[0].starts_at).toBe('08:00:00');
    expect(shiftRes.rows[0].ends_at).toBe('14:00:00');
  });

  it('aborts the migration when a location shift length cannot fit the day', async () => {
    // Same fresh-PGlite, pre-migration-insert pattern as above: the shift length must be
    // recorded on the OLD (pre-0002) schema before 0002 runs, so the guard has something
    // to reject during the migration itself rather than at insert time.
    const oldModelDb = new PGlite();
    await oldModelDb.exec(INIT_SQL);

    const level = '77777777-7777-7777-7777-777777777777';
    const loc = '88888888-8888-8888-8888-888888888888';
    await oldModelDb.exec(`
      INSERT INTO levels (id, name, rate_per_hour) VALUES ('${level}', 'Junior', 20.00);
      INSERT INTO locations (id, name, standard_shift_hours) VALUES ('${loc}', 'Overnight', 25.00);
    `);

    // 25.00 is load-bearing: it wraps past opens_at (08:00 + 25h -> 09:00), which passes
    // the closes_at > opens_at ordering check, so ONLY locations_shift_hours_fit_day can
    // catch it. Values like 16.00 or 48.00 would abort via the ordering check even with
    // the fit-day guard removed, making this test vacuous. Do not change this value.
    await expect(oldModelDb.exec(HOURS_MODEL_SQL)).rejects.toThrow();
  });
});
