import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/testDb';
import type { AppEnv, TokenVerifier } from './auth/types';
import { authMiddleware } from './auth/middleware';

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
}

/**
 * Build the API app. Dependency-injected so tests can supply a PGlite db and a
 * fake verifier. Later plans register their route groups where indicated.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', authMiddleware(deps.verifier));
  app.get('/api/me', (c) => c.json(c.get('principal')));

  // Route groups from later plans mount here, e.g.:
  //   app.route('/api/levels', createLevelRoutes(deps));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    // Intentional HTTP errors carry developer-authored messages (safe to show).
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Never leak raw error detail (SQL, ARNs) to clients; log server-side.
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}