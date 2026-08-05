import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { MIGRATIONS } from '@salary/core/migrations';
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
    try {
      await client.send(
        new ExecuteStatementCommand({
          resourceArn: config.resourceArn,
          secretArn: config.secretArn,
          database: config.dbName,
          sql,
        }),
      );
      applied += 1;
    } catch (err) {
      errors.push(`migration ${index + 1}: ${(err as Error).message}`);
      break; // stop at the first failure — later migrations assume earlier ones applied
    }
  }

  return { applied, errors };
}
