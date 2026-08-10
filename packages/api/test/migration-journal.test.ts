import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATION_NAMES } from '@salary/core/migrations';
import { runMigrations } from '../src/migrationHandler';

/** Adapter: the journal logic runs statements through this narrow interface, so tests
 *  drive it with PGlite while production drives it with the Data API client. */
function pgliteExecutor(db: PGlite) {
  return async (sql: string) => {
    const res = await db.query(sql);
    return res.rows as Record<string, unknown>[];
  };
}

describe('migration journal', () => {
  it('applies everything to an empty database and records each name', async () => {
    const db = new PGlite();
    const result = await runMigrations(pgliteExecutor(db));
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(MIGRATION_NAMES.length);
    expect(result.skipped).toBe(0);
    const rows = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.rows.map((r) => r.name)).toEqual([...MIGRATION_NAMES].sort());
  });

  it('is idempotent: a second run applies nothing and fails nothing', async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const again = await runMigrations(pgliteExecutor(db));
    expect(again.errors).toEqual([]);
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(MIGRATION_NAMES.length);
  });

  it('adopts a pre-journal database: schema exists, journal does not', async () => {
    /* The deployed DB was migrated before the journal existed. The handler must detect
     * an existing schema (levels table present, journal absent), seed the journal with
     * every migration name WITHOUT re-running them, and then apply only what's new. */
    const db = new PGlite();
    // Simulate the pre-journal world: run all migrations directly, no journal.
    const { MIGRATIONS } = await import('@salary/core/migrations');
    const { splitSqlStatements } = await import('@salary/core');
    for (const sql of MIGRATIONS) for (const s of splitSqlStatements(sql)) await db.query(s);

    const result = await runMigrations(pgliteExecutor(db));
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(MIGRATION_NAMES.length);
  });

  it('rejects a partially-migrated pre-journal database instead of guessing', async () => {
    /* Simulates a DB restored from an old snapshot: only the first five migrations ran
     * (0001-0005), no journal. `levels` exists (0001) but `schedule_publication_overrides`
     * does not (0007) — the adoption probe must detect this straddle and refuse to seed
     * the journal, rather than assuming 0006/0007 also ran. */
    const db = new PGlite();
    const { MIGRATIONS } = await import('@salary/core/migrations');
    const { splitSqlStatements } = await import('@salary/core');
    for (const sql of MIGRATIONS.slice(0, 5)) for (const s of splitSqlStatements(sql)) await db.query(s);

    await expect(runMigrations(pgliteExecutor(db))).rejects.toThrow(/partially migrated/);

    const rows = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.rows).toEqual([]);
  });

  it('applies only the tail when the journal is behind', async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    // Un-record the last migration and drop nothing — pretend it never ran by removing
    // its journal row after applying a fresh DB minus that migration is impractical;
    // instead verify the selection logic directly: delete the last row, re-run, and
    // expect exactly one 'applied' attempt (it will error on already-existing objects,
    // proving it was ATTEMPTED — the selection is what's under test).
    const last = [...MIGRATION_NAMES].sort().at(-1)!;
    await db.query(`DELETE FROM schema_migrations WHERE name = '${last}'`);
    const result = await runMigrations(pgliteExecutor(db));
    expect(result.skipped).toBe(MIGRATION_NAMES.length - 1);
    // applied + errored-on-attempt accounts for the one unrecorded migration
    expect(result.applied + result.errors.length).toBe(1);
  });
});
