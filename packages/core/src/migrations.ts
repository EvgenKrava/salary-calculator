import { MIGRATION_SQL, MIGRATION_NAMES } from './migrations.generated';

/**
 * The migration SQL, inlined at generation time from `db/migrations/*.sql`.
 *
 * **Do not switch this back to `readFileSync`** — it cost a cold-start crash. Two separate
 * things break when the SQL is read from disk:
 *
 *  1. Locating the directory needed `dirname(fileURLToPath(import.meta.url))`, which works
 *     under Vitest and `tsx` but not in a bundle: esbuild's CJS output emits
 *     `var import_meta = {}`, so `import_meta.url` is `undefined` and `fileURLToPath` throws
 *     a TypeError the instant the module is loaded — the Lambda died at cold start, before
 *     any handler code ran.
 *  2. Terraform packages a single `.js` file, so `db/migrations/*.sql` is not in the zip at
 *     all. Even a correct path would fail with ENOENT.
 *
 * Importing generated TypeScript fixes both: any bundler inlines it with no build flags, and
 * nothing touches the filesystem at runtime. Edit the `.sql` files and run
 * `pnpm --filter @salary/core generate:migrations`; `migrations.test.ts` fails if the
 * generated module drifts from the `.sql` sources.
 */

function read(name: string): string {
  const sql = MIGRATION_SQL[name];
  if (typeof sql !== 'string') {
    throw new Error(
      `migration '${name}' is missing from migrations.generated.ts — run ` +
        `'pnpm --filter @salary/core generate:migrations'`,
    );
  }
  return sql;
}

/** The initial schema migration. */
export const INIT_SQL = read('0001_init.sql');

/** The hours-based model migration. */
export const HOURS_MODEL_SQL = read('0002_hours_model.sql');

/** The schedule-import migration. */
export const SCHEDULE_IMPORT_SQL = read('0003_schedule_import.sql');

/** The day-rate migration: levels carry a rate per DAY, pro-rated by hours worked. */
export const DAY_RATE_SQL = read('0004_day_rate.sql');

/** Enum columns become TEXT + CHECK so the RDS Data API can write them. */
export const ENUM_TO_TEXT_SQL = read('0005_enum_to_text.sql');

/** Draft shift status, day-off requests, publication state, and standing settings. */
export const SCHEDULE_AUTHORING_SQL = read('0006_schedule_authoring.sql');

/** History of override reasons for publishing over a required day-off conflict. */
export const PUBLICATION_OVERRIDES_SQL = read('0007_publication_overrides.sql');

/**
 * All migrations in apply order.
 *
 * Derived from the generated key order (filename-sorted) rather than a hand-written list, so
 * adding a `.sql` file and regenerating is enough — there is no second place to update and
 * therefore no way to add a migration that silently never runs.
 */
export const MIGRATIONS: string[] = MIGRATION_NAMES.map(read);

/** Migration filenames in apply order, re-exported so consumers outside `@salary/core`
 *  (the migration journal) don't need the `./migrations.generated` subpath, which isn't
 *  in this package's `exports` map. */
export { MIGRATION_NAMES };
