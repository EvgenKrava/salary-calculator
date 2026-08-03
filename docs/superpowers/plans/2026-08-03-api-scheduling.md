# API Scheduling Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the scheduling endpoints to the API — employees submit shift requests and view their own shifts; managers list, directly assign, approve, reject, and remove shifts — building on the existing `createApp`, auth, and Drizzle layer.

**Architecture:** A single `createShiftRoutes(db)` Hono sub-app mounted at `/api/shifts`, with **per-route** role gating (employee self-service and manager operations coexist under the same prefix). A shared `currentEmployee(db, c)` helper resolves the authenticated principal to their employee row via `cognito_sub`. All writes respect the `shifts` UNIQUE(employee_id, work_date) invariant (one shift per employee per day) and validate referenced `employeeId`/`locationId` existence, returning `409`/`400` rather than leaking a `500`.

**Tech Stack:** Hono, Drizzle ORM, Zod, Vitest — all already in `@salary/api`.

## Global Constraints

- **Node** `>=20`, **pnpm**; work only in `packages/api`. TypeScript strict, ESM, extensionless relative imports.
- **Role gating (design §2, §5):** employee self-service (`POST /requests`, `GET /me`) → `requireRole('employee')`; manager operations (`GET /`, `POST /`, `POST /:id/approve`, `POST /:id/reject`, `DELETE /:id`) → `requireRole('manager', 'admin')`.
- **Employee identity comes from the token, never the body.** A shift request is always for the caller's own employee record (resolved via `cognito_sub`); an employee cannot request on behalf of another. A caller with no linked employee row → `403`.
- **Statuses** are `requested | approved | rejected`; **source** for native scheduling is `native`. New employee requests are `requested`; manager direct-assign defaults to `approved`. (Extraction-sourced shifts are a later plan.)
- **Invariants:** one shift per `(employeeId, workDate)` → duplicate → `409`. `workDate` is `'YYYY-MM-DD'`. Referenced `employeeId`/`locationId` must exist → otherwise `400` (`unknown ...Id`). Unknown shift id → `404`. Validation failure → `400`. All errors JSON.
- **Consumes `@salary/core`** for domain types; never re-implement domain logic. **Build only what each task specifies.**

---

### Task 1: Employee self-service (request + own shifts)

**Files:**
- Create: `packages/api/src/http/employeeContext.ts`
- Create: `packages/api/src/routes/shifts.ts`
- Modify: `packages/api/src/app.ts` (mount the routes)
- Test: `packages/api/test/shifts-employee.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppEnv`/`requireRole`, `readJson`, the `shifts`/`locations`/`employees` tables.
- Produces:
  - `currentEmployee(db: Db, c: Context<AppEnv>): Promise<EmployeeRow>` — resolves the caller to their employee row via `cognito_sub`; throws `403` if none.
  - `createShiftRoutes(db: Db): Hono<AppEnv>` mounted at `/api/shifts`, initially with `POST /requests` and `GET /me`. Shift DTO: `{ id, employeeId, locationId, workDate, status, source }`.

- [ ] **Step 1: Write the failing employee-scheduling test**

`packages/api/test/shifts-employee.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'alice') return { sub: 'sub-alice', groups: ['employee'] };
    if (token === 'nobody') return { sub: 'sub-none', groups: ['employee'] };
    throw new Error('bad');
  },
};
const ALICE = { Authorization: 'Bearer alice' };
const NOBODY = { Authorization: 'Bearer nobody' };
const MGR = { Authorization: 'Bearer mgr' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db, client } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, cognitoSub: 'sub-alice' })
    .returning();
  const app = createApp({ db, verifier });
  return { app, db, client, loc, alice };
}

describe('employee scheduling', () => {
  it('lets an employee request a shift (status requested)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(201);
    const shift = await res.json();
    expect(shift).toMatchObject({ locationId: loc.id, workDate: '2026-08-10', status: 'requested', source: 'native' });
  });

  it('rejects a request for a caller with no employee profile (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...NOBODY, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(403);
  });

  it('forbids a manager from the employee request route (403)', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown locationId with 400', async () => {
    const { app } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: '00000000-0000-0000-0000-000000000000', workDate: '2026-08-10' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a badly-formatted workDate with 400', async () => {
    const { app, loc } = await seed();
    const res = await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '08/10/2026' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s a second request on the same day', async () => {
    const { app, loc } = await seed();
    const body = JSON.stringify({ locationId: loc.id, workDate: '2026-08-11' });
    await app.request('/api/shifts/requests', { method: 'POST', headers: { ...ALICE, ...JSONH }, body });
    const res = await app.request('/api/shifts/requests', { method: 'POST', headers: { ...ALICE, ...JSONH }, body });
    expect(res.status).toBe(409);
  });

  it('lists only the caller’s own shifts', async () => {
    const { app, loc } = await seed();
    await app.request('/api/shifts/requests', {
      method: 'POST',
      headers: { ...ALICE, ...JSONH },
      body: JSON.stringify({ locationId: loc.id, workDate: '2026-08-12' }),
    });
    const res = await app.request('/api/shifts/me', { headers: ALICE });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].workDate).toBe('2026-08-12');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test shifts-employee`
Expected: FAIL — routes not mounted / `../src/routes/shifts` and `../src/http/employeeContext` missing.

- [ ] **Step 3: Implement the employee-context helper**

`packages/api/src/http/employeeContext.ts`:
```ts
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { employees } from '../schema';

export type EmployeeRow = typeof employees.$inferSelect;

/** Resolve the authenticated caller to their employee row via cognito_sub. */
export async function currentEmployee(db: Db, c: Context<AppEnv>): Promise<EmployeeRow> {
  const principal = c.get('principal');
  const rows = await db.select().from(employees).where(eq(employees.cognitoSub, principal.sub));
  if (rows.length === 0) {
    throw new HTTPException(403, { message: 'no employee profile linked to this account' });
  }
  return rows[0];
}
```

- [ ] **Step 4: Implement the shift routes (employee endpoints)**

`packages/api/src/routes/shifts.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';
import { currentEmployee } from '../http/employeeContext';
import { shifts, locations } from '../schema';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const requestSchema = z.object({ locationId: z.string().uuid(), workDate: dateString });

type ShiftRow = typeof shifts.$inferSelect;
function toDto(row: ShiftRow) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    locationId: row.locationId,
    workDate: row.workDate,
    status: row.status,
    source: row.source,
  };
}

export function createShiftRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  async function requireLocation(locationId: string): Promise<void> {
    const rows = await db.select().from(locations).where(eq(locations.id, locationId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown locationId' });
  }

  async function assertNoShiftThatDay(employeeId: string, workDate: string): Promise<void> {
    const existing = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.employeeId, employeeId), eq(shifts.workDate, workDate)));
    if (existing.length > 0) throw new HTTPException(409, { message: 'a shift already exists for that day' });
  }

  routes.post('/requests', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const body = await readJson(c, requestSchema);
    await requireLocation(body.locationId);
    await assertNoShiftThatDay(employee.id, body.workDate);
    const [row] = await db
      .insert(shifts)
      .values({
        employeeId: employee.id,
        locationId: body.locationId,
        workDate: body.workDate,
        status: 'requested',
        source: 'native',
      })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.get('/me', requireRole('employee'), async (c) => {
    const employee = await currentEmployee(db, c);
    const rows = await db.select().from(shifts).where(eq(shifts.employeeId, employee.id));
    return c.json(rows.map(toDto));
  });

  return routes;
}
```

- [ ] **Step 5: Mount the routes in `createApp`**

In `packages/api/src/app.ts`, add after the employees import:
```ts
import { createShiftRoutes } from './routes/shifts';
```
And after the `app.route('/api/employees', ...)` line add:
```ts
  app.route('/api/shifts', createShiftRoutes(deps.db));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test shifts-employee`
Expected: PASS — all employee-scheduling tests green.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/http/employeeContext.ts packages/api/src/routes/shifts.ts packages/api/src/app.ts packages/api/test/shifts-employee.test.ts
git commit -m "Add employee shift requests and self shift listing"
```

---

### Task 2: Manager scheduling (list, assign, approve, reject, delete)

**Files:**
- Modify: `packages/api/src/routes/shifts.ts` (add manager routes)
- Test: `packages/api/test/shifts-manager.test.ts`

**Interfaces:**
- Consumes: everything from Task 1 plus the `employees` table and drizzle `gte`/`lte`.
- Produces (added to `createShiftRoutes`):
  - `GET /` — list all shifts, optional `?status=&from=&to=` filters (manager/admin).
  - `POST /` — assign `{ employeeId, locationId, workDate, status? }` (default `approved`), source `native` (manager/admin).
  - `POST /:id/approve`, `POST /:id/reject` — set status (manager/admin).
  - `DELETE /:id` — remove a shift (manager/admin).

- [ ] **Step 1: Write the failing manager-scheduling test**

`packages/api/test/shifts-manager.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'alice') return { sub: 'sub-alice', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const ALICE = { Authorization: 'Bearer alice' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
  const [loc] = await db.insert(locations).values({ name: 'A', standardShiftHours: '8.00' }).returning();
  const [alice] = await db
    .insert(employees)
    .values({ name: 'Alice', levelId: level.id, cognitoSub: 'sub-alice' })
    .returning();
  return { app: createApp({ db, verifier }), loc, alice };
}

async function assign(app: Awaited<ReturnType<typeof seed>>['app'], body: object) {
  return app.request('/api/shifts', { method: 'POST', headers: { ...MGR, ...JSONH }, body: JSON.stringify(body) });
}

describe('manager scheduling', () => {
  it('forbids an employee from the manager list route (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/shifts', { headers: ALICE })).status).toBe(403);
  });

  it('assigns a shift (default approved) and lists it', async () => {
    const { app, loc, alice } = await seed();
    const res = await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'approved', source: 'native', employeeId: alice.id });

    const list = await app.request('/api/shifts', { headers: MGR });
    expect((await list.json())).toHaveLength(1);
  });

  it('rejects assign with unknown employee or location (400)', async () => {
    const { app, loc, alice } = await seed();
    const badEmp = await assign(app, { employeeId: '00000000-0000-0000-0000-000000000000', locationId: loc.id, workDate: '2026-08-10' });
    expect(badEmp.status).toBe(400);
    const badLoc = await assign(app, { employeeId: alice.id, locationId: '00000000-0000-0000-0000-000000000000', workDate: '2026-08-10' });
    expect(badLoc.status).toBe(400);
  });

  it('409s an assign that duplicates an employee-day', async () => {
    const { app, loc, alice } = await seed();
    await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    const dup = await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' });
    expect(dup.status).toBe(409);
  });

  it('approves and rejects a requested shift', async () => {
    const { app, loc, alice } = await seed();
    const created = await (await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', status: 'requested' })).json();

    const approved = await app.request(`/api/shifts/${created.id}/approve`, { method: 'POST', headers: MGR });
    expect(approved.status).toBe(200);
    expect((await approved.json()).status).toBe('approved');

    const rejected = await app.request(`/api/shifts/${created.id}/reject`, { method: 'POST', headers: MGR });
    expect((await rejected.json()).status).toBe('rejected');
  });

  it('404s approve/delete on an unknown shift', async () => {
    const { app } = await seed();
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await app.request(`/api/shifts/${missing}/approve`, { method: 'POST', headers: MGR })).status).toBe(404);
    expect((await app.request(`/api/shifts/${missing}`, { method: 'DELETE', headers: MGR })).status).toBe(404);
  });

  it('filters the list by status', async () => {
    const { app, loc, alice } = await seed();
    await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10', status: 'approved' });
    const requested = await app.request('/api/shifts?status=requested', { headers: MGR });
    expect(await requested.json()).toHaveLength(0);
    const approved = await app.request('/api/shifts?status=approved', { headers: MGR });
    expect(await approved.json()).toHaveLength(1);
  });

  it('deletes a shift', async () => {
    const { app, loc, alice } = await seed();
    const created = await (await assign(app, { employeeId: alice.id, locationId: loc.id, workDate: '2026-08-10' })).json();
    const del = await app.request(`/api/shifts/${created.id}`, { method: 'DELETE', headers: MGR });
    expect(del.status).toBe(200);
    expect((await (await app.request('/api/shifts', { headers: MGR })).json())).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test shifts-manager`
Expected: FAIL — manager routes not implemented (requests to `/api/shifts` GET/POST return 404, and approve/reject/delete are missing).

- [ ] **Step 3: Add the manager routes to `createShiftRoutes`**

In `packages/api/src/routes/shifts.ts`:
Update the drizzle-orm import to add `gte`, `lte`, and the `SQL` type:
```ts
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
```
Add `employees` to the schema import:
```ts
import { shifts, locations, employees } from '../schema';
```
Add the assign schema after `requestSchema`:
```ts
const assignSchema = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
  workDate: dateString,
  status: z.enum(['requested', 'approved']).default('approved'),
});
```
Inside `createShiftRoutes`, add a `requireEmployee` helper next to `requireLocation`:
```ts
  async function requireEmployee(employeeId: string): Promise<void> {
    const rows = await db.select().from(employees).where(eq(employees.id, employeeId));
    if (rows.length === 0) throw new HTTPException(400, { message: 'unknown employeeId' });
  }
```
Then add the manager routes just before `return routes;`:
```ts
  routes.get('/', requireRole('manager', 'admin'), async (c) => {
    const filters: SQL[] = [];
    const status = c.req.query('status');
    if (status === 'requested' || status === 'approved' || status === 'rejected') {
      filters.push(eq(shifts.status, status));
    }
    const from = c.req.query('from');
    if (from) filters.push(gte(shifts.workDate, from));
    const to = c.req.query('to');
    if (to) filters.push(lte(shifts.workDate, to));
    const rows = filters.length
      ? await db.select().from(shifts).where(and(...filters))
      : await db.select().from(shifts);
    return c.json(rows.map(toDto));
  });

  routes.post('/', requireRole('manager', 'admin'), async (c) => {
    const body = await readJson(c, assignSchema);
    await requireEmployee(body.employeeId);
    await requireLocation(body.locationId);
    await assertNoShiftThatDay(body.employeeId, body.workDate);
    const [row] = await db
      .insert(shifts)
      .values({
        employeeId: body.employeeId,
        locationId: body.locationId,
        workDate: body.workDate,
        status: body.status,
        source: 'native',
      })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.post('/:id/approve', requireRole('manager', 'admin'), async (c) => {
    const [row] = await db
      .update(shifts)
      .set({ status: 'approved' })
      .where(eq(shifts.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json(toDto(row));
  });

  routes.post('/:id/reject', requireRole('manager', 'admin'), async (c) => {
    const [row] = await db
      .update(shifts)
      .set({ status: 'rejected' })
      .where(eq(shifts.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', requireRole('manager', 'admin'), async (c) => {
    const [row] = await db.delete(shifts).where(eq(shifts.id, c.req.param('id'))).returning();
    if (!row) throw new HTTPException(404, { message: 'shift not found' });
    return c.json({ deleted: row.id });
  });
```

- [ ] **Step 4: Run the manager + employee tests to verify they pass**

Run: `pnpm --filter @salary/api test shifts-manager`
Then: `pnpm --filter @salary/api test shifts-employee`
Expected: PASS — all manager tests green, and Task 1's employee tests still green.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm --filter @salary/api test` → all green.
Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/shifts.ts packages/api/test/shifts-manager.test.ts
git commit -m "Add manager shift assign, approve, reject, delete, and listing"
```

---

## Self-Review

**Spec coverage (design §2, §5):**
- Employee submits requests / views own shifts → Task 1 (`POST /requests`, `GET /me`, gated `employee`, identity from token).
- Manager approves/rejects requests, directly assigns, lists → Task 2.
- Both paths converge on `shifts` with `source='native'`; extraction-sourced shifts are a later plan (noted).
- One-shift-per-employee-per-day invariant → `assertNoShiftThatDay` → 409, tested on both request and assign.
- Referenced-id validation → `requireLocation`/`requireEmployee` → 400 (applying the levelId lesson from the people plan), tested.
- Role isolation → employee forbidden on manager routes (403) and manager forbidden on employee request route (403), both tested.

**Placeholder scan:** No TBD/TODO. Approve/reject set the status unconditionally on an existing shift (idempotent, no state-machine guard) — this is intentional and sufficient for the manager workflow; not a gap.

**Type consistency:** `Db`, `AppEnv`, `requireRole`, `readJson` reused; `currentEmployee` returns the shared `EmployeeRow`; DTO fields match `shifts.$inferSelect`; the `status` query filter narrows to the literal union before `eq` (no `any` cast); `createShiftRoutes` mounted once at `/api/shifts`.
---

## Post-Review Fixes (applied after the whole-branch review)

The opus whole-branch review approved the security surface but flagged error-contract edges. Applied:

1. **UUID `:id` validation** on approve/reject/delete — a malformed id returns `404` (shift not found), not a `500` from the Postgres `uuid` cast.
2. **Date-filter validation** on `GET /` — `from`/`to` that aren't `YYYY-MM-DD` return `400`, not a `500` from the `date` cast.
3. **Unique-violation → 409** — replaced the `assertNoShiftThatDay` read-then-insert pre-check with a `try/insert/catch` that maps a Postgres unique violation (`isUniqueViolation` in `src/http/dbErrors.ts`) to `409`. Fixes the TOCTOU race (concurrent duplicate → 409 not 500) and is exercised by the existing duplicate-day tests. Reusable by later plans (revenue/salary).
4. **`currentEmployee` requires `active = true`** — a deactivated employee whose `cognito_sub` still resolves gets `403`, not self-service access.
5. Added regression tests: malformed id → 404, malformed date filter → 400, body-injected `employeeId` ignored (identity from token), deactivated employee → 403.
