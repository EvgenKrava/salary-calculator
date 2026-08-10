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

  it('forbids a manager from WRITING levels', async () => {
    const app = await makeApp();
    const created = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...MGR, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(created.status).toBe(403);

    const patched = await app.request('/api/levels/00000000-0000-0000-0000-000000000001', {
      method: 'PATCH',
      headers: { ...MGR, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky2' }),
    });
    expect(patched.status).toBe(403);
  });

  it('creates and lists a level, carrying no pay data of its own', async () => {
    // Pay now lives on the (level, location) pay_rates matrix, not on the level — a level is a
    // pure label. `ratePerDay` must be absent from the response, not just unset.
    const app = await makeApp();
    const created = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Junior' }),
    });
    expect(created.status).toBe(201);
    const level = (await created.json()) as { id: string; name: string };
    expect(level).toEqual({ id: level.id, name: 'Junior' });
    expect(level).not.toHaveProperty('ratePerDay');
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
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name with 409', async () => {
    const app = await makeApp();
    const body = JSON.stringify({ name: 'Dup' });
    await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    const res = await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    expect(res.status).toBe(409);
  });

  it('gets, updates the name, and 404s a level', async () => {
    const app = await makeApp();
    const created = (await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Mid' }),
      })
    ).json()) as { id: string; name: string };

    const got = await app.request(`/api/levels/${created.id}`, { headers: ADMIN });
    expect(got.status).toBe(200);
    expect(await got.json()).not.toHaveProperty('ratePerDay');

    const patched = await app.request(`/api/levels/${created.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Mid-2' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { id: string; name: string };
    expect(patchedBody.name).toBe('Mid-2');
    expect(patchedBody).not.toHaveProperty('ratePerDay');

    const missing = await app.request('/api/levels/00000000-0000-0000-0000-000000000000', { headers: ADMIN });
    expect(missing.status).toBe(404);
  });

  it('rejects a PATCH with no fields to update', async () => {
    // ratePerDay used to be a valid field to patch; now that it is gone, an empty-looking
    // update (only unknown keys) must still 400 rather than silently succeed.
    const app = await makeApp();
    const created = (await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Empty' }),
      })
    ).json()) as { id: string };
    const res = await app.request(`/api/levels/${created.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('deletes a level and 404s when already deleted', async () => {
    const app = await makeApp();
    const level = (await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Del' }),
      })
    ).json()) as { id: string; name: string };

    const del = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);

    const missing = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(missing.status).toBe(404);
  });
});
