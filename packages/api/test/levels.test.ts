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

describe('levels routes', () => {
  it('lets a manager READ levels, so the employees screen can name them', async () => {
    const app = await makeApp();
    const res = await app.request('/api/levels', { headers: MGR });
    expect(res.status).toBe(200);
  });

  it('forbids a manager from WRITING levels (rates stay admin-only)', async () => {
    const app = await makeApp();
    const created = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...MGR, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky', ratePerDay: 999 }),
    });
    expect(created.status).toBe(403);

    const patched = await app.request('/api/levels/00000000-0000-0000-0000-000000000001', {
      method: 'PATCH',
      headers: { ...MGR, 'content-type': 'application/json' },
      body: JSON.stringify({ ratePerDay: 999 }),
    });
    expect(patched.status).toBe(403);
  });

  it('creates and lists a level', async () => {
    const app = await makeApp();
    const created = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Junior', ratePerDay: 20 }),
    });
    expect(created.status).toBe(201);
    const level = (await created.json()) as { id: string; name: string; ratePerDay: number };
    expect(level).toMatchObject({ name: 'Junior', ratePerDay: 20 });
    expect(typeof level.id).toBe('string');

    const list = await app.request('/api/levels', { headers: ADMIN });
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);
  });

  it('rejects a bad payload with 400', async () => {
    const app = await makeApp();
    const res = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: '', ratePerDay: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name with 409', async () => {
    const app = await makeApp();
    const body = JSON.stringify({ name: 'Dup', ratePerDay: 10 });
    await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    const res = await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    expect(res.status).toBe(409);
  });

  it('gets, updates, and 404s a level', async () => {
    const app = await makeApp();
    const created = (await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Mid', ratePerDay: 30 }),
      })
    ).json()) as { id: string; name: string; ratePerDay: number };

    const got = await app.request(`/api/levels/${created.id}`, { headers: ADMIN });
    expect(got.status).toBe(200);

    const patched = await app.request(`/api/levels/${created.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ ratePerDay: 35 }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { id: string; name: string; ratePerDay: number }).ratePerDay).toBe(35);

    const missing = await app.request('/api/levels/00000000-0000-0000-0000-000000000000', { headers: ADMIN });
    expect(missing.status).toBe(404);
  });

  it('deletes a level and 404s when already deleted', async () => {
    const app = await makeApp();
    const level = (await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Del', ratePerDay: 15 }),
      })
    ).json()) as { id: string; name: string; ratePerDay: number };

    const del = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);

    const missing = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(missing.status).toBe(404);
  });
});