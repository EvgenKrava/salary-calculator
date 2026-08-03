import type { MiddlewareHandler } from 'hono';
import type { AppEnv, TokenVerifier } from './types';

/** Authenticate a Bearer token and attach the principal to the context. */
export function authMiddleware(verifier: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      const principal = await verifier.verify(header.slice('Bearer '.length));
      c.set('principal', principal);
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}

/** Require the principal to belong to at least one of the given Cognito groups. */
export function requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!roles.some((role) => principal.groups.includes(role))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}