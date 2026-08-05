import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, INIT_SQL, HOURS_MODEL_SQL, SCHEDULE_IMPORT_SQL, DAY_RATE_SQL, ENUM_TO_TEXT_SQL } from '../src/migrations';
import { MIGRATION_SQL, MIGRATION_NAMES } from '../src/migrations.generated';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../db/migrations');

function sqlFilesOnDisk(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('migrations', () => {
  it('has no runtime filesystem or import.meta dependency', () => {
    // The whole point of generating the SQL: this module must be loadable inside a
    // single-file CJS bundle, where `import.meta.url` is undefined and the .sql files are
    // absent. If someone reintroduces either, the Lambda crashes at cold start — which no
    // other test in this suite would catch, since Vitest runs from source as ESM.
    const source = readFileSync(join(here, '../src/migrations.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/import\.meta/);
    expect(code).not.toMatch(/readFileSync|node:fs/);
  });

  it('stays in sync with the .sql files on disk', () => {
    // Guards the generated module against drift: edit a .sql file, forget to regenerate,
    // and the Lambda would apply stale schema while local PGlite tests used the new SQL.
    const onDisk = sqlFilesOnDisk();
    expect(MIGRATION_NAMES).toEqual(onDisk);
    for (const name of onDisk) {
      expect(MIGRATION_SQL[name], `${name} differs from db/migrations/${name}`).toBe(
        readFileSync(join(migrationsDir, name), 'utf8'),
      );
    }
  });

  it('exposes every migration in filename order', () => {
    expect(MIGRATIONS).toEqual([INIT_SQL, HOURS_MODEL_SQL, SCHEDULE_IMPORT_SQL, DAY_RATE_SQL, ENUM_TO_TEXT_SQL]);
    expect(MIGRATIONS).toHaveLength(sqlFilesOnDisk().length);
  });

  it('exports non-empty SQL for each migration', () => {
    for (const sql of MIGRATIONS) expect(sql.trim().length).toBeGreaterThan(0);
  });
});
