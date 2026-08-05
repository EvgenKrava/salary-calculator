import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { LoginExistsError, type IdentityProvider } from '../src/auth/identityProvider';
import { levels, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

/**
 * Inviting an employee: create the Cognito login, assign the role group, link the sub.
 *
 * Before this route existed, onboarding meant two `aws cognito-idp` CLI calls plus copying a
 * `sub` UUID by hand — so the app could not actually be used end-to-end. The tests below focus
 * on the failure paths, because the happy path is the easy part: a half-created invite either
 * leaves a login nobody can reach or an employee row pointing at a login that does not exist,
 * and neither is visible in the UI.
 */

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

function fakeIdp(overrides: Partial<IdentityProvider> = {}) {
  return {
    createUser: vi.fn(async () => ({ sub: 'cognito-sub-1' })),
    disableUser: vi.fn(async () => {}),
    enableUser: vi.fn(async () => {}),
    setGroup: vi.fn(async () => {}),
    deleteUser: vi.fn(async () => {}),
    ...overrides,
  } satisfies IdentityProvider;
}

async function seed(identity?: IdentityProvider) {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'Barista', ratePerHour: '100' }).returning();
  const [employee] = await db
    .insert(employees)
    .values({ name: 'Olena', levelId: level.id, revenuePercent: '0.05' })
    .returning();
  return { app: createApp({ db, verifier, identity }), db, employee };
}

const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ email: 'olena@example.com', role: 'employee', ...extra });

describe('employee invite', () => {
  it('creates the login, assigns the role, and links the sub in one call', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);

    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: employee.id,
      cognitoSub: 'cognito-sub-1',
      email: 'olena@example.com',
    });
    // The role must reach Cognito — a login in no group authenticates and then 403s on
    // everything, with no UI to repair it.
    expect(idp.createUser).toHaveBeenCalledWith({ email: 'olena@example.com', group: 'employee' });
  });

  it('normalises the email, so Olena@Example.com and olena@example.com are one login', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ email: '  Olena@Example.COM  ' }),
    });
    expect(idp.createUser).toHaveBeenCalledWith({ email: 'olena@example.com', group: 'employee' });
  });

  it('persists the link, so the employee is reachable by sub afterwards', async () => {
    const idp = fakeIdp();
    const { app, db, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    const [row] = await db.select().from(employees);
    // /api/shifts/me and /api/salary-runs/me resolve the employee from the JWT sub, so an
    // unpersisted link means a login that works but sees nothing.
    expect(row.cognitoSub).toBe('cognito-sub-1');
  });

  it('rejects an invalid role instead of creating a login in a group that does not exist', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ role: 'superuser' }),
    });
    expect(res.status).toBe(400);
    expect(idp.createUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed email before touching Cognito', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(idp.createUser).not.toHaveBeenCalled();
  });

  it('409s a second invite rather than creating a duplicate login', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);
    const first = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(first.status).toBe(201);

    const again = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ email: 'other@example.com' }),
    });
    expect(again.status).toBe(409);
    // The second call must not reach Cognito at all — a created-then-orphaned login is the
    // failure this guards.
    expect(idp.createUser).toHaveBeenCalledTimes(1);
  });

  it('409s when the email already has a login, with a readable message', async () => {
    const idp = fakeIdp({
      createUser: vi.fn(async () => {
        throw new LoginExistsError('olena@example.com');
      }),
    });
    const { app, employee } = await seed(idp);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/already exists/);
  });

  it('refuses a blank sub instead of linking the employee to nothing', async () => {
    // cognito_sub is UNIQUE, so ONE blank link would then block every later invite with an
    // opaque constraint violation — while this invite reported success.
    const idp = fakeIdp({ createUser: vi.fn(async () => ({ sub: '   ' })) });
    const { app, db, employee } = await seed(idp);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(502);
    const [row] = await db.select().from(employees);
    expect(row.cognitoSub).toBeNull();
  });

  it('rolls the login back when linking fails, so a retry is not blocked', async () => {
    // Cognito succeeds, the DB write then fails. Without rollback the manager is stuck: the
    // email is taken by a login no employee row points at, and the UI offers no way to see it.
    const idp = fakeIdp();
    const { app, db, employee } = await seed(idp);
    // Fail ONLY the linking UPDATE. Renaming the table would also break the SELECT that runs
    // before createUser, so the test would never reach the path it is meant to cover.
    vi.spyOn(db, 'update').mockImplementationOnce((() => {
      throw new Error('connection reset during link');
    }) as never);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The orphaned login must be cleaned up, or the email stays taken by an account no
    // employee row points at and the manager cannot retry.
    expect(idp.deleteUser).toHaveBeenCalledWith('cognito-sub-1');
  });

  it('refuses to invite an inactive employee', async () => {
    const idp = fakeIdp();
    const { app, db, employee } = await seed(idp);
    await db.update(employees).set({ active: false });
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(409);
    expect(idp.createUser).not.toHaveBeenCalled();
  });

  it('404s an unknown employee without creating a login', async () => {
    const idp = fakeIdp();
    const { app } = await seed(idp);
    const res = await app.request('/api/employees/00000000-0000-0000-0000-000000000000/invite', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(404);
    expect(idp.createUser).not.toHaveBeenCalled();
  });

  it('forbids an employee from inviting anyone (403)', async () => {
    const idp = fakeIdp();
    const { app, employee } = await seed(idp);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...EMP, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(403);
    expect(idp.createUser).not.toHaveBeenCalled();
  });

  it('503s rather than crashing when no identity provider is configured', async () => {
    const { app, employee } = await seed(undefined);
    const res = await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    expect(res.status).toBe(503);
  });
});

describe('deactivation disables the login', () => {
  let idp: ReturnType<typeof fakeIdp>;
  beforeEach(() => {
    idp = fakeIdp();
  });

  it('disables the Cognito user when an employee is deactivated', async () => {
    // Otherwise a departed employee keeps working credentials: /api/shifts/me and
    // /api/salary-runs/me resolve from the JWT sub, so they would retain read access to their
    // own payroll records indefinitely.
    const { app, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });

    const res = await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);
    expect(idp.disableUser).toHaveBeenCalledWith('cognito-sub-1');
    // Disabled, never deleted — the salary history must survive.
    expect(idp.deleteUser).not.toHaveBeenCalled();
  });

  it('re-enables the login when the employee is reactivated', async () => {
    const { app, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false }),
    });
    await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: true }),
    });
    expect(idp.enableUser).toHaveBeenCalledWith('cognito-sub-1');
  });

  it('does not fail the payroll change when Cognito is unavailable', async () => {
    // The DB write is the authoritative record and is already committed. Failing the request
    // would leave a manager unable to deactivate anyone during a Cognito outage.
    const failing = fakeIdp({
      createUser: vi.fn(async () => ({ sub: 'cognito-sub-1' })),
      disableUser: vi.fn(async () => {
        throw new Error('ServiceUnavailable');
      }),
    });
    const { app, employee } = await seed(failing);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    const res = await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { active: boolean }).active).toBe(false);
  });

  it('skips the Cognito call for an employee with no login', async () => {
    const { app, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false }),
    });
    expect(idp.disableUser).not.toHaveBeenCalled();
  });

  it('does not touch Cognito when the patch does not change active', async () => {
    const { app, employee } = await seed(idp);
    await app.request(`/api/employees/${employee.id}/invite`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body(),
    });
    await app.request(`/api/employees/${employee.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ name: 'Olena K.' }),
    });
    expect(idp.disableUser).not.toHaveBeenCalled();
    expect(idp.enableUser).not.toHaveBeenCalled();
  });
});
