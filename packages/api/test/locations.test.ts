import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'admin') return { sub: 'u-admin', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const ADMIN = { Authorization: 'Bearer admin' };
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function makeApp() {
  const { db } = await createTestDb();
  return createApp({ db, verifier });
}

describe('locations routes', () => {
  it('lets a manager READ locations, so shift/revenue tables can name them', async () => {
    // Admin-only reads made every location render as '—' on the manager screens: data that
    // looks present but anonymous, which reads as correct and is worse than an error.
    const app = await makeApp();
    const res = await app.request('/api/locations', { headers: MGR });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('forbids a manager from WRITING locations (setup stays admin-only)', async () => {
    const app = await makeApp();
    const created = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Sneaky', opensAt: '08:00', closesAt: '16:00' }),
    });
    expect(created.status).toBe(403);

    // And the loosened GET must not have loosened the id-scoped mutations either.
    const patched = await app.request('/api/locations/00000000-0000-0000-0000-000000000001', {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(patched.status).toBe(403);

    const deleted = await app.request('/api/locations/00000000-0000-0000-0000-000000000001', {
      method: 'DELETE',
      headers: MGR,
    });
    expect(deleted.status).toBe(403);
  });

  it('forbids an employee entirely', async () => {
    const app = await makeApp();
    expect((await app.request('/api/locations', { headers: EMP })).status).toBe(403);
  });

  it('creates, lists, gets, updates a location', async () => {
    const app = await makeApp();
    const created = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Downtown', opensAt: '08:00', closesAt: '16:00' }),
    });
    expect(created.status).toBe(201);
    const loc = (await created.json()) as { id: string; name: string; opensAt: string; closesAt: string };
    expect(loc).toMatchObject({ name: 'Downtown', opensAt: '08:00', closesAt: '16:00' });

    expect((await (await app.request('/api/locations', { headers: ADMIN })).json())).toHaveLength(1);
    expect((await app.request(`/api/locations/${loc.id}`, { headers: ADMIN })).status).toBe(200);

    const patched = await app.request(`/api/locations/${loc.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ closesAt: '18:00' }),
    });
    expect(((await patched.json()) as { closesAt: string }).closesAt).toBe('18:00');
  });

  it('rejects closesAt not after opensAt (400)', async () => {
    const app = await makeApp();
    const res = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Bad', opensAt: '18:00', closesAt: '09:00' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name with 409', async () => {
    const app = await makeApp();
    const body = JSON.stringify({ name: 'Dup', opensAt: '08:00', closesAt: '16:00' });
    await app.request('/api/locations', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    expect((await app.request('/api/locations', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body })).status).toBe(409);
  });

  it('404s an unknown location', async () => {
    const app = await makeApp();
    expect((await app.request('/api/locations/00000000-0000-0000-0000-000000000000', { headers: ADMIN })).status).toBe(404);
  });

  it('400s a PATCH that inverts the window against the stored opensAt', async () => {
    const app = await makeApp();
    // Create a location with opensAt: '08:00', closesAt: '16:00'
    const created = await app.request('/api/locations', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'TestLoc', opensAt: '08:00', closesAt: '16:00' }),
    });
    expect(created.status).toBe(201);
    const loc = (await created.json()) as { id: string };

    // PATCH only closesAt to '07:00', earlier than stored opensAt '08:00'
    const patched = await app.request(`/api/locations/${loc.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ closesAt: '07:00' }),
    });
    expect(patched.status).toBe(400);
  });
});
