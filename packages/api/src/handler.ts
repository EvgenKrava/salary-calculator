import { handle } from 'hono/aws-lambda';
import { createApp } from './app';
import { cognitoVerifier } from './auth/cognitoVerifier';
import { createCognitoIdentityProvider } from './auth/identityProvider';
import { createProdDb, readEnvConfig } from './db/prodDb';

const config = readEnvConfig(process.env);
const app = createApp({
  db: createProdDb(config),
  verifier: cognitoVerifier({ userPoolId: config.userPoolId, clientId: config.clientId }),
  // Lets a manager invite an employee (create the login, assign the role group, link the sub)
  // in one action instead of two AWS CLI calls plus a hand-copied UUID.
  identity: createCognitoIdentityProvider({
    region: config.region,
    userPoolId: config.userPoolId,
  }),
});

export const handler = handle(app);
