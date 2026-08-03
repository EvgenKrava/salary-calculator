export interface Principal {
  sub: string;
  groups: string[];
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

/** Hono environment: middleware populates `principal` after authentication. */
export type AppEnv = { Variables: { principal: Principal } };