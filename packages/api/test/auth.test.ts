import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, requireRole } from '../src/auth/middleware';
import type { AppEnv, TokenVerifier } from '../src/auth/types';

function fakeVerifier(map: Record<string, { sub: string; groups: string[] }>): TokenVerifier {
  return {
    async verify(token) {
      const principal = map[token];
      if (!principal) throw new Error('invalid token');
      return principal;
    },
  };
}

function appWith(verifier: TokenVerifier) {
  const app = new Hono<AppEnv>();
  app.use('*', authMiddleware(verifier));
  app.get('/whoami', (c) => c.json(c.get('principal')));
  app.get('/admin', requireRole('admin'), (c) => c.json({ ok: true }));
  return app;
}

const verifier = fakeVerifier({
  'mgr-token': { sub: 'u-mgr', groups: ['manager'] },
  'admin-token': { sub: 'u-admin', groups: ['admin'] },
});

describe('authMiddleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await appWith(verifier).request('/whoami');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Token x' } });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('sets the principal for a valid token', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Bearer mgr-token' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'u-mgr', groups: ['manager'] });
  });
});

describe('requireRole', () => {
  it('allows a principal that has the role', async () => {
    const res = await appWith(verifier).request('/admin', { headers: { Authorization: 'Bearer admin-token' } });
    expect(res.status).toBe(200);
  });

  it('forbids a principal missing the role', async () => {
    const res = await appWith(verifier).request('/admin', { headers: { Authorization: 'Bearer mgr-token' } });
    expect(res.status).toBe(403);
  });
});