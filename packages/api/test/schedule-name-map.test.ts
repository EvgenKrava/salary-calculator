import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '20.00' }).returning();
  const [alice] = await db.insert(employees).values({ name: 'Alice', levelId: level.id }).returning();
  return { app: createApp({ db, verifier }), alice };
}

describe('schedule name map', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/schedule-name-map', { headers: EMP })).status).toBe(403);
  });

  it('maps a source name to an employee and lists it', async () => {
    const { app, alice } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Олег', employeeId: alice.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceName: 'Олег', employeeId: alice.id, ignored: false });
    const list = await app.request('/api/schedule-name-map', { headers: MGR });
    expect(await list.json()).toHaveLength(1);
  });

  it('marks a placeholder row ignored', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Бариста 1', ignored: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true, employeeId: null });
  });

  it('rejects a mapping that is neither resolved nor ignored (400)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Nobody' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects both employeeId and ignored together (400)', async () => {
    const { app, alice } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Both', employeeId: alice.id, ignored: true }),
    });
    expect(res.status).toBe(400);
  });

  it('400s an unknown employeeId', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Ghost', employeeId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(400);
  });

  it('re-mapping the same source name replaces it', async () => {
    const { app, alice } = await seed();
    const body = JSON.stringify({ sourceName: 'Олег', employeeId: alice.id });
    await app.request('/api/schedule-name-map', { method: 'PUT', headers: { ...MGR, ...JSONH }, body });
    const again = await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Олег', ignored: true }),
    });
    expect(again.status).toBe(200);
    expect((await (await app.request('/api/schedule-name-map', { headers: MGR })).json())).toHaveLength(1);
  });

  it('deletes a mapping', async () => {
    const { app } = await seed();
    await app.request('/api/schedule-name-map', {
      method: 'PUT',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ sourceName: 'Temp', ignored: true }),
    });
    const del = await app.request('/api/schedule-name-map/Temp', { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
    expect((await app.request('/api/schedule-name-map/Temp', { method: 'DELETE', headers: MGR })).status).toBe(404);
  });
});
