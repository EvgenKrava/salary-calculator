import { handle } from 'hono/aws-lambda';
import { createApp } from './app';
import { cognitoVerifier } from './auth/cognitoVerifier';
import { createCognitoIdentityProvider } from './auth/identityProvider';
import { createProdDb, readEnvConfig } from './db/prodDb';
import { createS3UploadSigner } from './routes/uploads';

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
  // Lets a manager photograph a hand-written revenue sheet and have AI read it: the browser PUTs
  // straight to S3, whose ObjectCreated event triggers the extraction Lambda.
  uploadSigner: process.env.DOCUMENTS_BUCKET
    ? createS3UploadSigner({ region: config.region, bucket: process.env.DOCUMENTS_BUCKET })
    : undefined,
});

export const handler = handle(app);
