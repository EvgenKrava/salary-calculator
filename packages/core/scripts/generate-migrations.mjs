#!/usr/bin/env node
/**
 * Generate `src/migrations.generated.ts` from `db/migrations/*.sql`.
 *
 * The SQL lives in `.sql` files because that is what you want to read, diff, and review.
 * But it must reach the Lambda **inside the JS bundle**: Terraform packages a single
 * `.js` file, so nothing can be read from disk at runtime, and the previous
 * `readFileSync(dirname(fileURLToPath(import.meta.url)))` approach crashed at cold start
 * (esbuild's CJS output emits `var import_meta = {}`, so the path was `undefined`).
 *
 * Generating a plain `.ts` module means any bundler inlines the SQL with no build flags,
 * and no filesystem access happens at runtime. The generated file is committed; the
 * `migrations.generated` test fails if it drifts from the `.sql` files.
 *
 * Run via `pnpm --filter @salary/core generate:migrations`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../db/migrations');
const outFile = join(here, '../src/migrations.generated.ts');

/** Read every migration in filename order. Numeric prefixes make lexical order apply order. */
export function readMigrations() {
  const names = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (names.length === 0) {
    throw new Error(`no .sql files in ${migrationsDir} — refusing to generate an empty module`);
  }
  return names.map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }));
}

/** Render the module source. Exported so the drift test compares against the same renderer. */
export function render(migrations) {
  const entries = migrations
    .map(({ name, sql }) => `  ${JSON.stringify(name)}: ${JSON.stringify(sql)},`)
    .join('\n');
  return `// GENERATED FILE — DO NOT EDIT.
// Source: packages/core/db/migrations/*.sql
// Regenerate: pnpm --filter @salary/core generate:migrations
//
// The SQL is inlined here so it travels inside the Lambda bundle; nothing is read from
// disk at runtime. Edit the .sql files, then regenerate.

/** Raw migration SQL keyed by filename, in apply order. */
export const MIGRATION_SQL: Record<string, string> = {
${entries}
};

/** Migration filenames in apply order. */
export const MIGRATION_NAMES: string[] = Object.keys(MIGRATION_SQL);
`;
}

// Only write when run directly, so the test can import the renderer without side effects.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const migrations = readMigrations();
  writeFileSync(outFile, render(migrations), 'utf8');
  console.log(`generated ${outFile} (${migrations.length}: ${migrations.map((m) => m.name).join(', ')})`);
}
