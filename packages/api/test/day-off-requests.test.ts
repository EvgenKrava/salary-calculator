import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, employees, appSettings, schedulePublications } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const OLENA_SUB = 'sub-olena';

const verifier: TokenVerifier = {
  async verify(token: string) {
    if (token === 'admin') return { sub: 'sub-admin', email: 'a@x', groups: ['admin'] };
    if (token === 'mgr') return { sub: 'sub-mgr', email: 'm@x', groups: ['manager'] };
    return { sub: OLENA_SUB, email: 'o@x', groups: ['employee'] };
  },
};

const ADMIN = { Authorization: 'Bearer admin', 'content-type': 'application/json' };
const MGR = { Authorization: 'Bearer mgr', 'content-type': 'application/json' };
const EMP = { Authorization: 'Bearer emp', 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '600.00' }).returning();
  const [olena] = await db
    .insert(employees)
    .values({ name: 'Олена', levelId: level.id, cognitoSub: OLENA_SUB })
    .returning();
  const [ihor] = await db.insert(employees).values({ name: 'Ігор', levelId: level.id }).returning();
  return { db, app: createApp({ db, verifier }), olena, ihor };
}

describe('day-off requests', () => {
  it('lets an employee record their own day off without naming themselves', async () => {
    const { app, olena } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { employeeId: string; kind: string };
    expect(body.employeeId).toBe(olena.id);
    expect(body.kind).toBe('required');
  });

  it('forbids an employee recording a day off for someone else', async () => {
    const { app, ihor } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: EMP,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin record a day off on an employee card', async () => {
    // The second write path: staff with no login yet, or who tell the manager verbally.
    const { app, ihor } = await seed();
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'preferred' }),
    });
    expect(res.status).toBe(201);
  });

  it('records who entered the request', async () => {
    const { db, app, ihor } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ employeeId: ihor.id, requestDate: '2026-09-05', kind: 'preferred' }),
    });
    const { dayOffRequests } = await import('../src/schema');
    const rows = await db.select().from(dayOffRequests);
    expect(rows[0].createdBy).toBe('sub-admin');
  });

  it('refuses a request past the configured limit, naming the limit', async () => {
    const { db, app } = await seed();
    await db.update(appSettings).set({ requiredDaysOffPerMonth: 1 });
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-01', kind: 'required' }),
    });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-02', kind: 'required' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('1');
  });

  it('changes the kind on a date already requested rather than erroring', async () => {
    // The picker cycles none → preferred → required → none; the middle step is an upsert.
    const { app } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'preferred' }),
    });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { kind: string }).kind).toBe('required');
  });

  it('refuses to change a month whose schedule is already published', async () => {
    const { db, app } = await seed();
    await db.insert(schedulePublications).values({ year: 2026, month: 9, publishedBy: 'sub-mgr' });
    const res = await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    expect(res.status).toBe(409);
  });

  it('deletes a request', async () => {
    const { app, olena } = await seed();
    await app.request('/api/day-off-requests', {
      method: 'PUT', headers: EMP,
      body: JSON.stringify({ requestDate: '2026-09-05', kind: 'required' }),
    });
    const res = await app.request(
      `/api/day-off-requests?employeeId=${olena.id}&date=2026-09-05`,
      { method: 'DELETE', headers: EMP },
    );
    expect(res.status).toBe(200);
  });

  it('scopes an employee GET to their own requests even if they ask for another id', async () => {
    const { db, app, ihor, olena } = await seed();
    const { dayOffRequests } = await import('../src/schema');
    await db.insert(dayOffRequests).values([
      { employeeId: olena.id, requestDate: '2026-09-01', kind: 'required', createdBy: OLENA_SUB },
      { employeeId: ihor.id, requestDate: '2026-09-02', kind: 'required', createdBy: 'sub-admin' },
    ]);
    const res = await app.request(`/api/day-off-requests?employeeId=${ihor.id}&year=2026&month=9`, {
      headers: EMP,
    });
    const body = (await res.json()) as { employeeId: string }[];
    expect(body.every((r) => r.employeeId === olena.id)).toBe(true);
  });

  it('lets a manager read everyone for a month', async () => {
    const { db, app, ihor, olena } = await seed();
    const { dayOffRequests } = await import('../src/schema');
    await db.insert(dayOffRequests).values([
      { employeeId: olena.id, requestDate: '2026-09-01', kind: 'required', createdBy: OLENA_SUB },
      { employeeId: ihor.id, requestDate: '2026-09-02', kind: 'preferred', createdBy: 'sub-admin' },
    ]);
    const res = await app.request('/api/day-off-requests?year=2026&month=9', { headers: MGR });
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });
});

describe('app settings', () => {
  it('serves the standing limits', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', { headers: MGR });
    expect(await res.json()).toEqual({ requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 });
  });

  it('lets an admin change a limit', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: ADMIN,
      body: JSON.stringify({ requiredDaysOffPerMonth: 3 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { requiredDaysOffPerMonth: number }).requiredDaysOffPerMonth).toBe(3);
  });

  it('forbids a manager changing the limits', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: MGR,
      body: JSON.stringify({ requiredDaysOffPerMonth: 3 }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a negative limit', async () => {
    const { app } = await seed();
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: ADMIN,
      body: JSON.stringify({ requiredDaysOffPerMonth: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
