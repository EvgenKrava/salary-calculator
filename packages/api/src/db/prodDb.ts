import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { z } from 'zod';
import * as schema from '../schema';
import type { Db } from './testDb';

const envSchema = z.object({
  AWS_REGION: z.string().min(1),
  DB_RESOURCE_ARN: z.string().min(1),
  DB_SECRET_ARN: z.string().min(1),
  DB_NAME: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
});

export interface ApiConfig {
  region: string;
  resourceArn: string;
  secretArn: string;
  dbName: string;
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