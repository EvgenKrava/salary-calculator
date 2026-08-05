import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/testDb';
import type { AppEnv, TokenVerifier } from './auth/types';
import { authMiddleware } from './auth/middleware';
import { createLevelRoutes } from './routes/levels';
import { createLocationRoutes } from './routes/locations';
import { createEmployeeRoutes } from './routes/employees';
import type { IdentityProvider } from './auth/identityProvider';
import { createShiftRoutes } from './routes/shifts';
import { createRevenueRoutes } from './routes/revenue';
import { createSalaryRunRoutes } from './routes/salaryRuns';
import { createShiftSlotRoutes } from './routes/shiftSlots';
import { createScheduleNameMapRoutes } from './routes/scheduleNameMap';
import { createScheduleImportRoutes } from './routes/scheduleImports';
import { createExtractionJobRoutes } from './routes/extractionJobs';

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  /**
   * Creates and disables Cognito logins. Optional: omitted in tests and in any deployment
   * without Cognito admin permissions, where the invite route returns 503 instead of failing
   * on undefined.
   */
  identity?: IdentityProvider;
}

/**
 * Build the API app. Dependency-injected so tests can supply a PGlite db and a
 * fake verifier. Later plans register their route groups where indicated.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  /**
   * CORS preflight, BEFORE the auth middleware.
   *
   * Browsers send `OPTIONS` with no `Authorization` header — that is the spec — so running
   * authMiddleware on it returns 401 and the browser surfaces only a bare "NetworkError when
   * attempting to fetch resource", hiding the status entirely. Every non-GET call from the SPA
   * failed this way while the API itself was healthy: the app looked completely broken.
   *
   * API Gateway's own `cors_configuration` adds the response headers, so this only has to end
   * the request without authenticating it. Returning 204 with no body is the correct preflight
   * response.
   */
  app.options('/api/*', (c) => c.body(null, 204));

  app.use('/api/*', authMiddleware(deps.verifier));
  app.get('/api/me', (c) => c.json(c.get('principal')));

  app.route('/api/levels', createLevelRoutes(deps.db));
  app.route('/api/locations', createLocationRoutes(deps.db));
  app.route('/api/employees', createEmployeeRoutes(deps.db, deps.identity));
  app.route('/api/shifts', createShiftRoutes(deps.db));
  app.route('/api/revenue', createRevenueRoutes(deps.db));
  app.route('/api/salary-runs', createSalaryRunRoutes(deps.db));
  app.route('/api/locations/:locationId/slots', createShiftSlotRoutes(deps.db));
  app.route('/api/schedule-name-map', createScheduleNameMapRoutes(deps.db));
  app.route('/api/schedule-imports', createScheduleImportRoutes(deps.db));
  app.route('/api/extraction-jobs', createExtractionJobRoutes(deps.db));

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