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

interface EmployeeDto {
  id: string;
  name: string;
  levelId: string;
  revenuePercent: number;
  cognitoSub: string | null;
  active: boolean;
}

async function makeApp() {
  const { db } = await createTestDb();
  return createApp({ db, verifier });
}

async function makeLevel(app: Awaited<ReturnType<typeof makeApp>>) {
  const res = await app.request('/api/levels', {
    method: 'POST',
    headers: { ...ADMIN, ...JSONH },
    body: JSON.stringify({ name: `L-${Math.round(performance.now() * 1000)}`, ratePerHour: 20 }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('employees routes', () => {
  it('forbids an employee-role user', async () => {
    const app = await makeApp();
    expect((await app.request('/api/employees', { headers: EMP })).status).toBe(403);
  });

  it('lets a manager create and list employees', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const created = await app.request('/api/employees', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Alice', levelId, revenuePercent: 0.05 }),
    });
    expect(created.status).toBe(201);
    const emp = await created.json();
    expect(emp).toMatchObject({ name: 'Alice', levelId, revenuePercent: 0.05, active: true, cognitoSub: null });

    const list = await app.request('/api/employees', { headers: MGR });
    expect(await list.json()).toHaveLength(1);
  });

  it('rejects revenuePercent outside [0,1] with 400', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const res = await app.request('/api/employees', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Bad', levelId, revenuePercent: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  it('defaults revenuePercent to 0 and active to true', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const emp = (await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'Min', levelId }),
      })
    ).json()) as EmployeeDto;
    expect(emp.revenuePercent).toBe(0);
    expect(emp.active).toBe(true);
  });

  it('updates an employee and deactivates via PATCH active=false', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const emp = (await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'Bob', levelId, revenuePercent: 0.1 }),
      })
    ).json()) as EmployeeDto;

    const patched = await app.request(`/api/employees/${emp.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false, revenuePercent: 0.2 }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as EmployeeDto;
    expect(body.active).toBe(false);
    expect(body.revenuePercent).toBe(0.2);
  });

  it('rejects a duplicate cognitoSub with 409', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const body = (name: string) => JSON.stringify({ name, levelId, cognitoSub: 'sub-123' });
    await app.request('/api/employees', { method: 'POST', headers: { ...MGR, ...JSONH }, body: body('A') });
    const res = await app.request('/api/employees', { method: 'POST', headers: { ...MGR, ...JSONH }, body: body('B') });
    expect(res.status).toBe(409);
  });

  it('404s an unknown employee', async () => {
    const app = await makeApp();
    expect((await app.request('/api/employees/00000000-0000-0000-0000-000000000000', { headers: MGR })).status).toBe(404);
  });

  it('409s when deleting a level that an employee references', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    await app.request('/api/employees', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Ref', levelId }),
    });
    const del = await app.request(`/api/levels/${levelId}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(409);
  });

  it('409s a PATCH that sets a cognitoSub already used by another employee', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const a = (await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'A', levelId, cognitoSub: 'sub-a' }),
      })
    ).json()) as { id: string };
    await app.request('/api/employees', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'B', levelId, cognitoSub: 'sub-b' }),
    });
    const res = await app.request(`/api/employees/${a.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ cognitoSub: 'sub-b' }),
    });
    expect(res.status).toBe(409);
  });

  it('allows a PATCH that re-sets an employee to its own current cognitoSub', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const a = (await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'A', levelId, cognitoSub: 'sub-a' }),
      })
    ).json()) as { id: string };
    const res = await app.request(`/api/employees/${a.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ cognitoSub: 'sub-a', name: 'A2' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects create with a well-formed but unknown levelId (400)', async () => {
    const app = await makeApp();
    const res = await app.request('/api/employees', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'X', levelId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a PATCH to an unknown levelId (400)', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const a = (await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'Y', levelId }),
      })
    ).json()) as { id: string };
    const res = await app.request(`/api/employees/${a.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ levelId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(400);
  });
});