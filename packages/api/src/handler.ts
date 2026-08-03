import { handle } from 'hono/aws-lambda';
import { createApp } from './app';
import { cognitoVerifier } from './auth/cognitoVerifier';
import { createProdDb, readEnvConfig } from './db/prodDb';

const config = readEnvConfig(process.env);
const app = createApp({
  db: createProdDb(config),
  verifier: cognitoVerifier({ userPoolId: config.userPoolId, clientId: config.clientId }),
});

export const handler = handle(app);