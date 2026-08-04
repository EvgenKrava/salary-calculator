import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { MIGRATIONS } from '@salary/core/migrations';
import * as schema from '../schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Create an isolated in-process Postgres (PGlite) with the schema applied. */
export async function createTestDb(): Promise<{ client: PGlite; db: Db }> {
  const client = new PGlite();
  for (const sql of MIGRATIONS) {
    await client.exec(sql);
  }
  const db = drizzle(client, { schema });
  return { client, db };
}