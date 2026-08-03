import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'admin') return { sub: 'u-admin', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    throw new Error('bad');
  },
};
const ADMIN = { Authorization: 'Bearer admin' };
const MGR = { Authorization: 'Bearer mgr' };
const JSONH = { 'content-type': 'application/json' };

async function makeApp() {
  const { db } = await createTestDb();
  return createApp({ db, verifier });
}

describe('locations routes', () => {
  it('forbids a non-admin', async () => {
    const app = await makeApp();
    expect((await app.request('/api/locations', { headers: MGR })).status).toBe(403);
  });

  it('creates, lists, gets, updates a location', async () => {
    const app = await makeApp();
    const created = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Downtown', standardShiftHours: 8 }),
    });
    expect(created.status).toBe(201);
    const loc = (await created.json()) as { id: string; name: string; standardShiftHours: number };
    expect(loc).toMatchObject({ name: 'Downtown', standardShiftHours: 8 });

    expect((await (await app.request('/api/locations', { headers: ADMIN })).json())).toHaveLength(1);
    expect((await app.request(`/api/locations/${loc.id}`, { headers: ADMIN })).status).toBe(200);

    const patched = await app.request(`/api/locations/${loc.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ standardShiftHours: 6 }),
    });
    expect(((await patched.json()) as { standardShiftHours: number }).standardShiftHours).toBe(6);
  });

  it('rejects zero/negative shift hours with 400', async () => {
    const app = await makeApp();
    const res = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Bad', standardShiftHours: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name with 409', async () => {
    const app = await makeApp();
    const body = JSON.stringify({ name: 'Dup', standardShiftHours: 8 });
    await app.request('/api/locations', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    expect((await app.request('/api/locations', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body })).status).toBe(409);
  });

  it('404s an unknown location', async () => {
    const app = await makeApp();
    expect((await app.request('/api/locations/00000000-0000-0000-0000-000000000000', { headers: ADMIN })).status).toBe(404);
  });
});