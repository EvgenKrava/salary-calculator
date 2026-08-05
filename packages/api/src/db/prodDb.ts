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
export function createProdDb(cfg: ApiConfig): Db {
  const client = new RDSDataClient({ region: cfg.region });
  return drizzle(client, {
    database: cfg.dbName,
    resourceArn: cfg.resourceArn,
    secretArn: cfg.secretArn,
    schema,
  }) as unknown as Db;
}