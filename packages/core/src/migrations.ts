import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(here, '../db/migrations', name), 'utf8');
}

/** The initial schema migration. Node-only. */
export const INIT_SQL = read('0001_init.sql');

/** The hours-based model migration. Node-only. */
export const HOURS_MODEL_SQL = read('0002_hours_model.sql');

/** All migrations in apply order. Node-only. */
export const MIGRATIONS: string[] = [INIT_SQL, HOURS_MODEL_SQL];
