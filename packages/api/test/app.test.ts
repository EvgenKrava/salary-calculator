import { describe, it, expect } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    throw new Error('bad');
  },
};

async function makeApp() {
  const { db } = await createTestDb();
  return createApp({ db, verifier });
}

describe('createApp', () => {
  it('serves an unauthenticated health check', async () => {
    const app = await makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('requires auth for /api/me', async () => {
    const app = await makeApp();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('returns the principal from /api/me when authenticated', async () => {
    const app = await makeApp();
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'u-mgr', groups: ['manager'] });
  });

  it('returns 404 JSON for an unknown route', async () => {
    const app = await makeApp();
    const res = await app.request('/api/does-not-exist', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(404);
  });

  it('preserves the status and message of an intentional HTTPException', async () => {
    const app = await makeApp();
    app.get('/boom-http', () => {
      throw new HTTPException(409, { message: 'conflict' });
    });
    const res = await app.request('/boom-http');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
  });

  it('maps an unexpected error to a 500 without leaking its message', async () => {
    const app = await makeApp();
    app.get('/boom-raw', () => {
      throw new Error('secret db ARN leak');
    });
    const res = await app.request('/boom-raw');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(body)).not.toContain('secret db ARN leak');
  });
});
describe('CORS preflight', () => {
  it('answers OPTIONS without a token, so the browser can preflight', async () => {
    // The bug this guards: authMiddleware ran on OPTIONS too, so the preflight 401'd and the
    // browser reported an opaque NetworkError — every POST/PATCH/DELETE from the SPA failed
    // while the API was healthy.
    const { db } = await createTestDb();
    const app = createApp({ db, verifier });
    const res = await app.request('/api/locations', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  it('still rejects a real request without a token', async () => {
    // The preflight exemption must not become an auth hole.
    const { db } = await createTestDb();
    const app = createApp({ db, verifier });
    expect((await app.request('/api/locations', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/locations')).status).toBe(401);
  });
});
