# API People & Setup Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the setup/people CRUD endpoints to the API — levels and locations (admin) and employees (manager/admin) — mounted into the existing `createApp`, with Zod validation, JSON errors, role gating, and conflict handling, all tested against PGlite.

**Architecture:** Each entity gets a route-factory (`createLevelRoutes(db)`, etc.) returning a Hono sub-app that is mounted under `/api/<entity>` inside `createApp`. Because `createApp` already applies `authMiddleware` to `/api/*`, every sub-app is authenticated; each sub-app additionally applies `requireRole(...)`. A shared HTTP helper module provides JSON body validation (`readJson`) and a not-found helper (`getOr404`). NUMERIC columns (money, rate, percent) cross the API boundary as **numbers** in JSON and are converted to/from Postgres's string representation at the mapper layer.

**Tech Stack:** Hono, Drizzle ORM (via the shared `Db` type), Zod, Vitest — all already in `@salary/api`.

## Global Constraints

- **Node** `>=20`, **pnpm**; work only in `packages/api`. TypeScript strict, ESM, extensionless relative imports.
- **All responses are JSON.** Errors are `{ "error": "<message>" }` with an appropriate status. `HTTPException` messages are developer-authored (safe to show); unexpected errors return `{ "error": "internal" }` (never the raw message).
- **Role gating (per design §2):** `levels` and `locations` → `admin` only. `employees` → `manager` or `admin`. Unauthenticated → `401` (already handled by `authMiddleware`); wrong role → `403`.
- **NUMERIC as number at the API boundary:** request bodies carry `ratePerHour`, `standardShiftHours`, `revenuePercent` as JSON **numbers**; responses return them as numbers; the DB layer stores/reads them as strings. `revenuePercent` is a fraction in `[0, 1]`.
- **Status codes:** `200` read/update, `201` create, `204`? — no, return the created/updated resource as JSON with `201`/`200`. Not found → `404`. Validation failure → `400`. Uniqueness or FK conflict → `409`.
- **Consumes `@salary/core`** for any domain types; never re-implement domain logic. **Build only what each task specifies.**

---

### Task 1: Shared HTTP helpers + JSON error responses

**Files:**
- Create: `packages/api/src/http/validation.ts`
- Modify: `packages/api/src/app.ts` (make `onError` emit JSON for `HTTPException`)
- Modify: `packages/api/test/app.test.ts` (assert JSON error bodies)
- Test: `packages/api/test/validation.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `readJson<T>(c: Context, schema: ZodSchema<T>): Promise<T>` — parses+validates the JSON body; throws `HTTPException(400, { message })` with a readable detail on failure (invalid JSON or schema mismatch).
  - `getOr404<T>(rows: T[], message?: string): T` — returns `rows[0]` or throws `HTTPException(404, { message })`.

- [ ] **Step 1: Write the failing validation-helper test**

`packages/api/test/validation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readJson, getOr404 } from '../src/http/validation';

const schema = z.object({ name: z.string().min(1) });

function app() {
  const a = new Hono();
  a.post('/echo', async (c) => c.json(await readJson(c, schema)));
  a.get('/first', (c) => c.json(getOr404([{ id: 'x' }])));
  a.get('/none', (c) => c.json(getOr404([] as { id: string }[], 'nope')));
  a.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: 'internal' }, 500);
  });
  return a;
}

describe('readJson', () => {
  it('returns parsed data for a valid body', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ok' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'ok' });
  });

  it('rejects an invalid body with 400 and a field detail', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('getOr404', () => {
  it('returns the first row when present', async () => {
    const res = await app().request('/first');
    expect(await res.json()).toEqual({ id: 'x' });
  });

  it('throws 404 when empty', async () => {
    const res = await app().request('/none');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'nope' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test validation`
Expected: FAIL — `../src/http/validation` does not exist.

- [ ] **Step 3: Implement the helpers**

`packages/api/src/http/validation.ts`:
```ts
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodSchema } from 'zod';

/** Parse and validate a JSON request body; throws HTTPException(400) on failure. */
export async function readJson<T>(c: Context, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new HTTPException(400, { message: `validation failed: ${detail}` });
  }
  return parsed.data;
}

/** Return the first row, or throw HTTPException(404) if there is none. */
export function getOr404<T>(rows: T[], message = 'not found'): T {
  if (rows.length === 0) throw new HTTPException(404, { message });
  return rows[0];
}
```

- [ ] **Step 4: Make `onError` emit JSON for HTTPException**

In `packages/api/src/app.ts`, replace the current `onError` body:
```ts
  app.onError((err, c) => {
    // Preserve intentional HTTP errors thrown by routes/validators.
    if (err instanceof HTTPException) return err.getResponse();
    // Never leak raw error detail (SQL, ARNs) to clients; log server-side.
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
```
with:
```ts
  app.onError((err, c) => {
    // Intentional HTTP errors carry developer-authored messages (safe to show).
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Never leak raw error detail (SQL, ARNs) to clients; log server-side.
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
```

- [ ] **Step 5: Update the app error tests to assert JSON bodies**

In `packages/api/test/app.test.ts`, replace the `HTTPException` status test so it also asserts the JSON body, and confirm the raw-error test is unchanged:
```ts
  it('preserves the status and message of an intentional HTTPException', async () => {
    const app = await makeApp();
    app.get('/boom-http', () => {
      throw new HTTPException(409, { message: 'conflict' });
    });
    const res = await app.request('/boom-http');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
  });
```

- [ ] **Step 6: Run the suite to verify it passes**

Run: `pnpm --filter @salary/api test`
Expected: PASS — validation tests green; updated app error test green; all prior tests still green.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/http/validation.ts packages/api/src/app.ts packages/api/test/validation.test.ts packages/api/test/app.test.ts
git commit -m "Add JSON validation helpers and JSON HTTPException responses"
```

---

### Task 2: Levels routes (admin CRUD)

**Files:**
- Create: `packages/api/src/routes/levels.ts`
- Modify: `packages/api/src/app.ts` (mount the routes)
- Test: `packages/api/test/levels.test.ts`

**Interfaces:**
- Consumes: `Db` (`../db/testDb`), `AppEnv` + `requireRole` (auth), `readJson`/`getOr404` (Task 1), `levels` table (schema).
- Produces: `createLevelRoutes(db: Db): Hono<AppEnv>` mounted at `/api/levels`. DTO shape: `{ id: string; name: string; ratePerHour: number }`.

- [ ] **Step 1: Write the failing levels test**

`packages/api/test/levels.test.ts`:
```ts
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
  it('forbids a non-admin', async () => {
    const app = await makeApp();
    const res = await app.request('/api/levels', { headers: MGR });
    expect(res.status).toBe(403);
  });

  it('creates and lists a level', async () => {
    const app = await makeApp();
    const created = await app.request('/api/levels', {
      method: 'POST',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ name: 'Junior', ratePerHour: 20 }),
    });
    expect(created.status).toBe(201);
    const level = await created.json();
    expect(level).toMatchObject({ name: 'Junior', ratePerHour: 20 });
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
      body: JSON.stringify({ name: '', ratePerHour: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name with 409', async () => {
    const app = await makeApp();
    const body = JSON.stringify({ name: 'Dup', ratePerHour: 10 });
    await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    const res = await app.request('/api/levels', { method: 'POST', headers: { ...ADMIN, ...JSONH }, body });
    expect(res.status).toBe(409);
  });

  it('gets, updates, and 404s a level', async () => {
    const app = await makeApp();
    const created = await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Mid', ratePerHour: 30 }),
      })
    ).json();

    const got = await app.request(`/api/levels/${created.id}`, { headers: ADMIN });
    expect(got.status).toBe(200);

    const patched = await app.request(`/api/levels/${created.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ ratePerHour: 35 }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).ratePerHour).toBe(35);

    const missing = await app.request('/api/levels/00000000-0000-0000-0000-000000000000', { headers: ADMIN });
    expect(missing.status).toBe(404);
  });

  it('deletes a level and 409s when an employee references it', async () => {
    const app = await makeApp();
    const level = await (
      await app.request('/api/levels', {
        method: 'POST',
        headers: { ...ADMIN, ...JSONH },
        body: JSON.stringify({ name: 'Del', ratePerHour: 15 }),
      })
    ).json();

    const del = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);

    const missing = await app.request(`/api/levels/${level.id}`, { method: 'DELETE', headers: ADMIN });
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test levels`
Expected: FAIL — routes not mounted / `../src/routes/levels` missing (requests 404 or import error).

- [ ] **Step 3: Implement the levels routes**

`packages/api/src/routes/levels.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { levels } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  ratePerHour: z.number().nonnegative(),
});
const updateSchema = z
  .object({ name: z.string().min(1), ratePerHour: z.number().nonnegative() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type LevelRow = typeof levels.$inferSelect;
function toDto(row: LevelRow) {
  return { id: row.id, name: row.name, ratePerHour: Number(row.ratePerHour) };
}

export function createLevelRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(levels);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const rows = await db.select().from(levels).where(eq(levels.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'level not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(levels).where(eq(levels.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'level name already exists' });
    const [row] = await db
      .insert(levels)
      .values({ name: body.name, ratePerHour: String(body.ratePerHour) })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof levels.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.ratePerHour !== undefined) patch.ratePerHour = String(body.ratePerHour);
    const [row] = await db
      .update(levels)
      .set(patch)
      .where(eq(levels.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'level not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const [row] = await db.delete(levels).where(eq(levels.id, c.req.param('id'))).returning();
    if (!row) throw new HTTPException(404, { message: 'level not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
```

Note on the delete FK case: a level referenced by an employee cannot be deleted — the FK raises an error that falls through to the generic `500` unless caught. Employees don't exist yet in this task's tests (so the 409-on-reference path is exercised in Task 4's employee tests, which create an employee then attempt to delete its level). This task's delete test covers the happy delete and the 404. Do NOT add speculative FK-catch code here; Task 4 adds the referenced-delete test and, if it observes a 500, this plan's Task 4 includes the fix.

- [ ] **Step 4: Mount the routes in `createApp`**

In `packages/api/src/app.ts`, add the import and mount. After the `import { authMiddleware } from './auth/middleware';` line add:
```ts
import { createLevelRoutes } from './routes/levels';
```
And replace the mount-point comment:
```ts
  // Route groups from later plans mount here, e.g.:
  //   app.route('/api/levels', createLevelRoutes(deps));
```
with:
```ts
  app.route('/api/levels', createLevelRoutes(deps.db));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test levels`
Expected: PASS — all levels tests green.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/levels.ts packages/api/src/app.ts packages/api/test/levels.test.ts
git commit -m "Add admin levels CRUD routes"
```

---

### Task 3: Locations routes (admin CRUD)

**Files:**
- Create: `packages/api/src/routes/locations.ts`
- Modify: `packages/api/src/app.ts` (mount the routes)
- Test: `packages/api/test/locations.test.ts`

**Interfaces:**
- Consumes: same as Task 2, plus the `locations` table.
- Produces: `createLocationRoutes(db: Db): Hono<AppEnv>` mounted at `/api/locations`. DTO: `{ id: string; name: string; standardShiftHours: number }`.

- [ ] **Step 1: Write the failing locations test**

`packages/api/test/locations.test.ts`:
```ts
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
    const loc = await created.json();
    expect(loc).toMatchObject({ name: 'Downtown', standardShiftHours: 8 });

    expect((await (await app.request('/api/locations', { headers: ADMIN })).json())).toHaveLength(1);
    expect((await app.request(`/api/locations/${loc.id}`, { headers: ADMIN })).status).toBe(200);

    const patched = await app.request(`/api/locations/${loc.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSONH },
      body: JSON.stringify({ standardShiftHours: 6 }),
    });
    expect((await patched.json()).standardShiftHours).toBe(6);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test locations`
Expected: FAIL — routes not mounted / file missing.

- [ ] **Step 3: Implement the locations routes**

`packages/api/src/routes/locations.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { locations } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  standardShiftHours: z.number().positive(),
});
const updateSchema = z
  .object({ name: z.string().min(1), standardShiftHours: z.number().positive() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type LocationRow = typeof locations.$inferSelect;
function toDto(row: LocationRow) {
  return { id: row.id, name: row.name, standardShiftHours: Number(row.standardShiftHours) };
}

export function createLocationRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(locations);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const rows = await db.select().from(locations).where(eq(locations.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'location not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    const existing = await db.select().from(locations).where(eq(locations.name, body.name));
    if (existing.length > 0) throw new HTTPException(409, { message: 'location name already exists' });
    const [row] = await db
      .insert(locations)
      .values({ name: body.name, standardShiftHours: String(body.standardShiftHours) })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof locations.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.standardShiftHours !== undefined) patch.standardShiftHours = String(body.standardShiftHours);
    const [row] = await db
      .update(locations)
      .set(patch)
      .where(eq(locations.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'location not found' });
    return c.json(toDto(row));
  });

  routes.delete('/:id', async (c) => {
    const [row] = await db.delete(locations).where(eq(locations.id, c.req.param('id'))).returning();
    if (!row) throw new HTTPException(404, { message: 'location not found' });
    return c.json({ deleted: row.id });
  });

  return routes;
}
```

- [ ] **Step 4: Mount the routes in `createApp`**

In `packages/api/src/app.ts`, add after the levels import:
```ts
import { createLocationRoutes } from './routes/locations';
```
And after the `app.route('/api/levels', ...)` line add:
```ts
  app.route('/api/locations', createLocationRoutes(deps.db));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test locations`
Expected: PASS — all locations tests green.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/locations.ts packages/api/src/app.ts packages/api/test/locations.test.ts
git commit -m "Add admin locations CRUD routes"
```

---

### Task 4: Employees routes (manager/admin) + level-delete FK guard

**Files:**
- Create: `packages/api/src/routes/employees.ts`
- Modify: `packages/api/src/app.ts` (mount the routes)
- Modify: `packages/api/src/routes/levels.ts` (guard delete against referencing employees)
- Test: `packages/api/test/employees.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppEnv`/`requireRole`, `readJson`/`getOr404`, the `employees` and `levels` tables.
- Produces: `createEmployeeRoutes(db: Db): Hono<AppEnv>` mounted at `/api/employees`. DTO: `{ id: string; name: string; levelId: string; revenuePercent: number; cognitoSub: string | null; active: boolean }`.

- [ ] **Step 1: Write the failing employees test**

`packages/api/test/employees.test.ts`:
```ts
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

async function makeLevel(app: Awaited<ReturnType<typeof makeApp>>) {
  const res = await app.request('/api/levels', {
    method: 'POST',
    headers: { ...ADMIN, ...JSONH },
    body: JSON.stringify({ name: `L-${Math.round(performance.now() * 1000)}`, ratePerHour: 20 }),
  });
  return (await res.json()).id as string;
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
    const emp = await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'Min', levelId }),
      })
    ).json();
    expect(emp.revenuePercent).toBe(0);
    expect(emp.active).toBe(true);
  });

  it('updates an employee and deactivates via PATCH active=false', async () => {
    const app = await makeApp();
    const levelId = await makeLevel(app);
    const emp = await (
      await app.request('/api/employees', {
        method: 'POST',
        headers: { ...MGR, ...JSONH },
        body: JSON.stringify({ name: 'Bob', levelId, revenuePercent: 0.1 }),
      })
    ).json();

    const patched = await app.request(`/api/employees/${emp.id}`, {
      method: 'PATCH',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ active: false, revenuePercent: 0.2 }),
    });
    expect(patched.status).toBe(200);
    const body = await patched.json();
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test employees`
Expected: FAIL — employee routes not mounted / file missing (and the level-FK test fails until Step 4's guard).

- [ ] **Step 3: Implement the employees routes**

`packages/api/src/routes/employees.ts`:
```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { employees } from '../schema';

const createSchema = z.object({
  name: z.string().min(1),
  levelId: z.string().uuid(),
  revenuePercent: z.number().min(0).max(1).default(0),
  cognitoSub: z.string().min(1).nullish(),
  active: z.boolean().default(true),
});
const updateSchema = z
  .object({
    name: z.string().min(1),
    levelId: z.string().uuid(),
    revenuePercent: z.number().min(0).max(1),
    cognitoSub: z.string().min(1).nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

type EmployeeRow = typeof employees.$inferSelect;
function toDto(row: EmployeeRow) {
  return {
    id: row.id,
    name: row.name,
    levelId: row.levelId,
    revenuePercent: Number(row.revenuePercent),
    cognitoSub: row.cognitoSub,
    active: row.active,
  };
}

export function createEmployeeRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  routes.get('/', async (c) => {
    const rows = await db.select().from(employees);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const rows = await db.select().from(employees).where(eq(employees.id, c.req.param('id')));
    return c.json(toDto(getOr404(rows, 'employee not found')));
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createSchema);
    if (body.cognitoSub) {
      const dupe = await db.select().from(employees).where(eq(employees.cognitoSub, body.cognitoSub));
      if (dupe.length > 0) throw new HTTPException(409, { message: 'cognitoSub already linked' });
    }
    const [row] = await db
      .insert(employees)
      .values({
        name: body.name,
        levelId: body.levelId,
        revenuePercent: String(body.revenuePercent),
        cognitoSub: body.cognitoSub ?? null,
        active: body.active,
      })
      .returning();
    return c.json(toDto(row), 201);
  });

  routes.patch('/:id', async (c) => {
    const body = await readJson(c, updateSchema);
    const patch: Partial<typeof employees.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.levelId !== undefined) patch.levelId = body.levelId;
    if (body.revenuePercent !== undefined) patch.revenuePercent = String(body.revenuePercent);
    if (body.cognitoSub !== undefined) patch.cognitoSub = body.cognitoSub;
    if (body.active !== undefined) patch.active = body.active;
    const [row] = await db
      .update(employees)
      .set(patch)
      .where(eq(employees.id, c.req.param('id')))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'employee not found' });
    return c.json(toDto(row));
  });

  return routes;
}
```

Note: employees have no hard `DELETE` — deactivation is via `PATCH { active: false }`, because employees are referenced by shifts and salary run lines and must be preserved for historical pay records.

- [ ] **Step 4: Add the level-delete FK guard and mount employee routes**

In `packages/api/src/routes/levels.ts`, add the `employees` import and guard the delete. Change the import block to also import employees and `count`:
```ts
import { eq, count } from 'drizzle-orm';
import { levels, employees } from '../schema';
```
Replace the `routes.delete('/:id', ...)` handler with:
```ts
  routes.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const [{ value: refs }] = await db
      .select({ value: count() })
      .from(employees)
      .where(eq(employees.levelId, id));
    if (refs > 0) throw new HTTPException(409, { message: 'level is referenced by employees' });
    const [row] = await db.delete(levels).where(eq(levels.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'level not found' });
    return c.json({ deleted: row.id });
  });
```

In `packages/api/src/app.ts`, add after the locations import:
```ts
import { createEmployeeRoutes } from './routes/employees';
```
And after the `app.route('/api/locations', ...)` line add:
```ts
  app.route('/api/employees', createEmployeeRoutes(deps.db));
```

- [ ] **Step 5: Run the employees + levels tests to verify they pass**

Run: `pnpm --filter @salary/api test employees`
Then: `pnpm --filter @salary/api test levels`
Expected: PASS — all employee tests green (including the level-FK 409), and the levels suite still green (the delete-happy-path test now runs the count guard first and still deletes since no employee references it).

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `pnpm --filter @salary/api test` → all green.
Run: `pnpm --filter @salary/api typecheck` → clean.
```bash
git add packages/api/src/routes/employees.ts packages/api/src/routes/levels.ts packages/api/src/app.ts packages/api/test/employees.test.ts
git commit -m "Add employee routes and guard level delete against references"
```

---

## Self-Review

**Spec coverage (design §2 roles, §4 data model):**
- Admin manages levels + locations → Tasks 2, 3 (`requireRole('admin')`).
- Manager manages employees (admin also permitted) → Task 4 (`requireRole('manager', 'admin')`).
- Employee cannot manage people → asserted in Task 4 (employee-role → 403).
- `revenuePercent` fraction in [0,1] → Zod `.min(0).max(1)`, tested with 1.5 → 400.
- Employees preserved (no hard delete; deactivate via `active`) → Task 4 (PATCH active=false; no DELETE route); level/location deletes guarded/handled.
- NUMERIC-as-number at the boundary → `toDto` converts with `Number(...)`, inserts with `String(...)`; asserted (`ratePerHour: 20`, `revenuePercent: 0.05`).
- JSON errors with correct status → Task 1 (`onError` JSON; `readJson` 400; `getOr404` 404; duplicate 409; FK 409).

**Placeholder scan:** No TBD/TODO. Task 2's delete intentionally defers the FK-reference case to Task 4 (where an employee exists to reference a level) — this is stated explicitly, not a gap, and Task 4 adds both the guard and its test.

**Type consistency:** `Db` reused from Task-0 foundation; `AppEnv`/`requireRole`/`readJson`/`getOr404` shared across all route files; DTO field names match the Drizzle `$inferSelect` columns; numeric insert values are strings (matching the schema's `numeric` columns) and DTO outputs are numbers. `createLevelRoutes`/`createLocationRoutes`/`createEmployeeRoutes` are each mounted exactly once in `createApp`.