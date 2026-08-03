import { describe, it, expect } from 'vitest';
import { readEnvConfig } from '../src/db/prodDb';

const complete = {
  AWS_REGION: 'us-east-1',
  DB_RESOURCE_ARN: 'arn:aws:rds:us-east-1:1:cluster:c',
  DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:s',
  DB_NAME: 'salary',
  COGNITO_USER_POOL_ID: 'us-east-1_abc',
  COGNITO_CLIENT_ID: 'client123',
};

describe('readEnvConfig', () => {
  it('parses a complete environment', () => {
    const cfg = readEnvConfig(complete);
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.dbName).toBe('salary');
    expect(cfg.userPoolId).toBe('us-east-1_abc');
  });

  it('throws listing the missing variable', () => {
    const { DB_NAME, ...missing } = complete;
    expect(() => readEnvConfig(missing)).toThrow(/DB_NAME/);
  });
});