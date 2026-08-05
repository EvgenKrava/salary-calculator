import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { MIGRATIONS } from '@salary/core/migrations';
import { splitSqlStatements } from '@salary/core';
import { readDbEnvConfig } from './db/prodDb';

/**
 * Apply every migration in order over the RDS Data API.
 *
 * Invoked on demand (not on a schedule) after the cluster is provisioned and after any
 * schema change. Migrations are not tracked in a journal table yet: 0001 and 0002 are not
 * idempotent (they CREATE and ALTER unconditionally), so re-running a already-applied
 * migration fails loudly rather than corrupting anything. That is the intended behaviour
 * for now — a journal table is a follow-up, not a silent re-run.
 */
export async function handler(): Promise<{ applied: number; errors: string[] }> {
  // Database settings only — this handler has no notion of auth, and validating the API's
  // Cognito variables here made every invocation throw after a clean apply.
  const config = readDbEnvConfig(process.env);
  const client = new RDSDataClient({ region: config.region });
  const errors: string[] = [];
  let applied = 0;

  for (const [index, sql] of MIGRATIONS.entries()) {
    // The Data API's ExecuteStatement takes exactly ONE statement and rejects a script with
    // "Multistatements aren't supported." PGlite's client.exec() — what the tests use —
    // accepts a whole file, which is why this passed every test and then applied 0 migrations
    // against the real cluster. Split and send one statement at a time.
    const statements = splitSqlStatements(sql);
    try {
      for (const [stmtIndex, statement] of statements.entries()) {
        try {
          await client.send(
            new ExecuteStatementCommand({
              resourceArn: config.resourceArn,
              secretArn: config.secretArn,
              database: config.dbName,
              sql: statement,
            }),
          );
        } catch (err) {
          // Name the statement, not just the file: a migration is dozens of statements and
          // "migration 2 failed" is not enough to find the problem.
          throw new Error(
            `statement ${stmtIndex + 1}/${statements.length} (${statement.slice(0, 80).replace(/\s+/g, ' ')}…): ${(err as Error).message}`,
          );
        }
      }
      applied += 1;
    } catch (err) {
      errors.push(`migration ${index + 1}: ${(err as Error).message}`);
      break; // stop at the first failure — later migrations assume earlier ones applied
    }
  }

  return { applied, errors };
}
