import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { MIGRATIONS, MIGRATION_NAMES } from '@salary/core/migrations';
import { splitSqlStatements } from '@salary/core';
import { readDbEnvConfig } from './db/prodDb';

type Executor = (sql: string) => Promise<Record<string, unknown>[]>;

export interface MigrateResult {
  applied: number;
  skipped: number;
  errors: string[];
}

/**
 * Apply migrations with a journal.
 *
 * The journal (`schema_migrations`) is created by the runner itself, not by a numbered
 * migration — the runner cannot depend on the thing it runs. Three situations:
 *
 *  1. Empty DB: journal is created, every migration applies, every name is recorded.
 *  2. Pre-journal DB (the deployed state before this handler shipped): the schema exists
 *     but the journal doesn't. Detected via `to_regclass('public.levels')` — the very
 *     first table 0001 creates. The journal is seeded with EVERY known name without
 *     re-running anything: those migrations are visibly already applied, and re-running
 *     0001 fails loudly by design.
 *  3. Journal present: apply exactly the migrations whose names are not recorded.
 *
 * Names come from MIGRATION_NAMES (filename-sorted, same order as MIGRATIONS) so the
 * journal rows and the SQL list can never disagree about identity.
 */
export async function runMigrations(execute: Executor): Promise<MigrateResult> {
  await execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );

  const journalRows = await execute('SELECT name FROM schema_migrations');
  const recorded = new Set(journalRows.map((r) => String(r.name)));

  if (recorded.size === 0) {
    // Journal is empty — but is the schema? to_regclass returns NULL (not an error) for a
    // missing relation, so this probe is safe on a genuinely empty database.
    const probe = await execute("SELECT to_regclass('public.levels') AS t");
    const schemaExists = probe.length > 0 && probe[0].t != null;
    if (schemaExists) {
      for (const name of MIGRATION_NAMES) {
        await execute(`INSERT INTO schema_migrations (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING`);
        recorded.add(name);
      }
    }
  }

  const errors: string[] = [];
  let applied = 0;
  let skipped = 0;

  for (const [index, sql] of MIGRATIONS.entries()) {
    const name = MIGRATION_NAMES[index];
    if (recorded.has(name)) {
      skipped += 1;
      continue;
    }
    const statements = splitSqlStatements(sql);
    try {
      for (const [stmtIndex, statement] of statements.entries()) {
        try {
          await execute(statement);
        } catch (err) {
          throw new Error(
            `statement ${stmtIndex + 1}/${statements.length} (${statement.slice(0, 80).replace(/\s+/g, ' ')}…): ${(err as Error).message}`,
          );
        }
      }
      await execute(`INSERT INTO schema_migrations (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING`);
      applied += 1;
    } catch (err) {
      errors.push(`migration ${name}: ${(err as Error).message}`);
      break; // later migrations assume earlier ones applied
    }
  }

  return { applied, skipped, errors };
}

/** Lambda entry point: the executor is the RDS Data API. */
export async function handler(): Promise<MigrateResult> {
  // Database settings only — this handler has no notion of auth, and validating the API's
  // Cognito variables here made every invocation throw after a clean apply.
  const config = readDbEnvConfig(process.env);
  const client = new RDSDataClient({ region: config.region });
  return runMigrations(async (sql) => {
    const res = await client.send(
      new ExecuteStatementCommand({
        resourceArn: config.resourceArn,
        secretArn: config.secretArn,
        database: config.dbName,
        sql,
        includeResultMetadata: true,
      }),
    );
    // Reduce the Data API's column/field structure to name->value records; only the
    // journal SELECT and the to_regclass probe read results.
    const cols = (res.columnMetadata ?? []).map((c) => c.name ?? '');
    return (res.records ?? []).map((rec) =>
      Object.fromEntries(rec.map((f, i) => [cols[i], f.stringValue ?? f.longValue ?? (f.isNull ? null : undefined)])),
    );
  });
}
