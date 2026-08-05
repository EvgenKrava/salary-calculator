import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { z } from 'zod';
import * as schema from '../schema';
import type { Db } from './testDb';

/**
 * Database connection settings. Split out from the Cognito settings on purpose: the migration
 * Lambda needs the database but has no notion of auth, and requiring Cognito variables it never
 * reads made every invocation throw `check env vars: COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID`
 * after a clean apply — so the schema was never created and nothing else in the stack worked.
 * Each entry point should validate only what it actually uses.
 */
const dbEnvSchema = z.object({
  AWS_REGION: z.string().min(1),
  DB_RESOURCE_ARN: z.string().min(1),
  DB_SECRET_ARN: z.string().min(1),
  DB_NAME: z.string().min(1),
});

const envSchema = dbEnvSchema.extend({
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
});

export interface DbConfig {
  region: string;
  resourceArn: string;
  secretArn: string;
  dbName: string;
}

export interface ApiConfig extends DbConfig {
  userPoolId: string;
  clientId: string;
}

/** Parse and validate the runtime environment; throws listing any missing keys. */
export function readEnvConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid API configuration; check env vars: ${keys}`);
  }
  const e = parsed.data;
  return {
    region: e.AWS_REGION,
    resourceArn: e.DB_RESOURCE_ARN,
    secretArn: e.DB_SECRET_ARN,
    dbName: e.DB_NAME,
    userPoolId: e.COGNITO_USER_POOL_ID,
    clientId: e.COGNITO_CLIENT_ID,
  };
}

/**
 * Validate only the database settings, for entry points that never touch auth (the migration
 * Lambda). Deliberately does NOT require the Cognito variables — see `dbEnvSchema`.
 */
export function readDbEnvConfig(env: Record<string, string | undefined>): DbConfig {
  const parsed = dbEnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid database configuration; check env vars: ${keys}`);
  }
  const e = parsed.data;
  return {
    region: e.AWS_REGION,
    resourceArn: e.DB_RESOURCE_ARN,
    secretArn: e.DB_SECRET_ARN,
    dbName: e.DB_NAME,
  };
}

/** Drizzle database backed by the Aurora Serverless v2 RDS Data API. */
/**
 * Wait out an Aurora Serverless v2 resume.
 *
 * The cluster runs at `min_capacity = 0` and auto-pauses after 5 idle minutes — that is what
 * keeps this deployment near $0/month instead of ~$44 (see infra/cost.md). The cost is that the
 * FIRST request after idle fails with `DatabaseResumingException` while the instance wakes,
 * roughly 10-20 seconds. Unhandled, that surfaced to the manager as `{"error":"internal"}` — so
 * the normal experience of opening the app each morning looked like the app was broken.
 *
 * Retrying inside the client makes the resume invisible: the request just takes a few seconds.
 * Only this one exception is retried, and only for a bounded time, so a genuine database error
 * still fails fast rather than hanging.
 */
function retryOnResume<T extends { send: (...args: never[]) => Promise<unknown> }>(client: T): T {
  const send = client.send.bind(client) as (...args: never[]) => Promise<unknown>;
  const MAX_WAIT_MS = 25_000; // under the API Gateway 30s ceiling, so we fail before it cuts us off
  const DELAY_MS = 1_500;

  client.send = (async (...args: never[]) => {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      try {
        return await send(...args);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== 'DatabaseResumingException' || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
  }) as T['send'];

  return client;
}

export function createProdDb(cfg: ApiConfig): Db {
  const client = retryOnResume(new RDSDataClient({ region: cfg.region }));
  return drizzle(client, {
    database: cfg.dbName,
    resourceArn: cfg.resourceArn,
    secretArn: cfg.secretArn,
    schema,
  }) as unknown as Db;
}