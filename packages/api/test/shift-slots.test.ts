import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { locations } from '../src/schema';
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

async function seed() {
  const { db } = await createTestDb();
  const [loc] = await db
    .insert(locations)
    .values({ name: 'A', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  return { app: createApp({ db, verifier }), loc };
}

describe('location shift slots', () => {
  it('forbids a manager from configuring slots (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(res.status).toBe(403);
  });

  it('creates, lists, and updates a slot window', async () => {
    const { app, loc } = await seed();
    const created = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ slotNumber: 1, startsAt: '08:00', endsAt: '14:00' });

    // PUT is an upsert: the same slot number replaces the window.
    const updated = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '09:00', endsAt: '15:00' }),
    });
    expect(((await updated.json()) as { startsAt: string }).startsAt).toBe('09:00');

    await app.request(`/api/locations/${loc.id}/slots/2`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '14:00', endsAt: '20:00' }),
    });
    const list = await app.request(`/api/locations/${loc.id}/slots`, { headers: ADMIN });
    expect(await list.json()).toHaveLength(2);
  });

  it('rejects an inverted or malformed window (400)', async () => {
    const { app, loc } = await seed();
    const inverted = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '14:00', endsAt: '08:00' }),
    });
    expect(inverted.status).toBe(400);
    const malformed = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '8:00', endsAt: '14:00' }),
    });
    expect(malformed.status).toBe(400);
  });

  it('rejects a slot window outside the location hours (400)', async () => {
    const { app, loc } = await seed(); // location A opens 08:00, closes 20:00
    const tooEarly = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '06:00', endsAt: '07:00' }),
    });
    expect(tooEarly.status).toBe(400);
    const tooLate = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '19:00', endsAt: '23:00' }),
    });
    expect(tooLate.status).toBe(400);
    // Exactly matching the location hours is allowed.
    const exact = await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '20:00' }),
    });
    expect(exact.status).toBe(200);
  });

  it('400s an unknown location and 404s a bad slot number', async () => {
    const { app, loc } = await seed();
    const badLoc = await app.request('/api/locations/00000000-0000-0000-0000-000000000000/slots/1', {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(badLoc.status).toBe(400);
    const badSlot = await app.request(`/api/locations/${loc.id}/slots/0`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    expect(badSlot.status).toBe(400);
  });

  it('deletes a slot', async () => {
    const { app, loc } = await seed();
    await app.request(`/api/locations/${loc.id}/slots/1`, {
      method: 'PUT',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ startsAt: '08:00', endsAt: '14:00' }),
    });
    const del = await app.request(`/api/locations/${loc.id}/slots/1`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);
    expect((await (await app.request(`/api/locations/${loc.id}/slots`, { headers: ADMIN })).json())).toHaveLength(0);
    const again = await app.request(`/api/locations/${loc.id}/slots/1`, { method: 'DELETE', headers: ADMIN });
    expect(again.status).toBe(404);
  });
});
