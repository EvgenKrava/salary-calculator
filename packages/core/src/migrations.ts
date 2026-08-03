import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The full text of the 0001_init.sql schema migration. Node-only. */
export const INIT_SQL = readFileSync(join(here, '../db/migrations/0001_init.sql'), 'utf8');