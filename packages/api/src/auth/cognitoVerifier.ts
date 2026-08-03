import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Principal, TokenVerifier } from './types';

/** Production verifier backed by Cognito's JWKS (access tokens). */
export function cognitoVerifier(cfg: { userPoolId: string; clientId: string }): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: cfg.userPoolId,
    tokenUse: 'access',
    clientId: cfg.clientId,
  });
  return {
    async verify(token: string): Promise<Principal> {
      const payload = await verifier.verify(token);
      const groups = payload['cognito:groups'] ?? [];
      return { sub: payload.sub, groups };
    },
  };
}