import { describe, it, expect } from 'vitest';
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
});