# API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the backend API skeleton — a Hono app running in one AWS Lambda behind API Gateway, with Cognito JWT authentication, role gating, and a Drizzle data layer that runs against PGlite in tests and Aurora Serverless v2 (RDS Data API) in production — so later plans can add endpoint groups on a tested foundation.

**Architecture:** A new `packages/api` workspace package. A dependency-injected app factory `createApp({ db, verifier })` builds a Hono router; this makes the whole API testable against an in-process PGlite database and a fake token verifier, with no AWS access. Production wires the same factory to a Cognito JWT verifier and a Drizzle RDS Data API client. The Drizzle schema mirrors the `0001_init.sql` DDL shipped by `@salary/core`; tests apply that exact SQL to PGlite so schema and ORM stay in lockstep.

**Tech Stack:** TypeScript (strict, ESM), Hono (+ `hono/aws-lambda`), Drizzle ORM (`drizzle-orm/pglite` for tests, `drizzle-orm/aws-data-api/pg` for prod), `aws-jwt-verify` for Cognito, Zod for request validation (used by later plans), Vitest.

## Global Constraints

- **Node** `>=20`; package manager **pnpm**; this package is `@salary/api` in the existing workspace.
- **TypeScript** strict, ESM (`"type": "module"`), `moduleResolution: "bundler"` — **extensionless** relative imports.
- **Consumes `@salary/core`** for domain types and the calculation engine; never re-implement domain logic here.
- **The Drizzle schema must match `packages/core/db/migrations/0001_init.sql` exactly** — same table names, column names (snake_case), enum values, and constraints. Tests prove this by applying that SQL file to PGlite and querying through Drizzle.
- **Auth model:** Cognito **access-token** JWT in the `Authorization: Bearer <token>` header. Role comes from the `cognito:groups` claim; the three roles are `admin`, `manager`, `employee`. Unauthenticated → `401`; authenticated but wrong role → `403`.
- **Testability is non-negotiable:** all request-level behavior is tested via Hono's `app.request(...)` against `createApp` wired with a **fake** `TokenVerifier` and a **PGlite** Drizzle db. No test may require AWS credentials or network.
- **Numeric columns:** Drizzle returns Postgres `NUMERIC` as **strings**; tests and mappers must treat money/rate/percent fields as strings at the DB boundary and convert explicitly.

---

### Task 1: Package scaffold + Drizzle schema + test DB helper

**Files:**
- Modify: `packages/core/package.json` (add a `./migrations` subpath export)
- Create: `packages/core/src/migrations.ts`
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/vitest.config.ts`
- Create: `packages/api/src/schema.ts`
- Create: `packages/api/src/db/testDb.ts`
- Test: `packages/api/test/schema.test.ts`

**Interfaces:**
- Consumes: `@salary/core` (already built).
- Produces:
  - `@salary/core/migrations` exporting `INIT_SQL: string` (the DDL text).
  - `packages/api/src/schema.ts` exporting Drizzle tables `levels`, `locations`, `employees`, `shifts`, `dailyRevenue`, `extractionJobs`, `salaryRuns`, `salaryRunLines` and the pg enums.
  - `createTestDb(): Promise<{ client: PGlite; db: Db }>` from `./db/testDb`, where `Db` is the Drizzle database type over the schema.

- [ ] **Step 1: Export the migration SQL from `@salary/core` as a Node-only subpath**

Add the subpath export to `packages/core/package.json` (keep the existing `"."` entry):
```json
  "exports": {
    ".": "./src/index.ts",
    "./migrations": "./src/migrations.ts"
  },
```

Create `packages/core/src/migrations.ts` (kept OUT of the main barrel so browser bundles never pull in `node:fs`):
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The full text of the 0001_init.sql schema migration. Node-only. */
export const INIT_SQL = readFileSync(join(here, '../db/migrations/0001_init.sql'), 'utf8');
```

- [ ] **Step 2: Create the api package config**

`packages/api/package.json`:
```json
{
  "name": "@salary/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@salary/core": "workspace:*",
    "@aws-sdk/client-rds-data": "^3.665.0",
    "aws-jwt-verify": "^4.0.1",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.12",
    "@types/aws-lambda": "^8.10.145",
    "@types/node": "^22.7.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.2"
  }
}
```

`packages/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`packages/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: `@salary/api` resolves `@salary/core` via `workspace:*` and installs hono, drizzle-orm, aws-jwt-verify, zod, and the dev deps with no errors.

- [ ] **Step 4: Write the Drizzle schema**

`packages/api/src/schema.ts`:
```ts
import {
  boolean,
  date,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const shiftStatus = pgEnum('shift_status', ['requested', 'approved', 'rejected']);
export const shiftSource = pgEnum('shift_source', ['native', 'extracted']);
export const revenueSource = pgEnum('revenue_source', ['manual', 'extracted']);
export const revenueStatus = pgEnum('revenue_status', ['pending', 'needs_review', 'approved', 'rejected']);
export const docType = pgEnum('doc_type', ['revenue', 'schedule']);
export const extractionStatus = pgEnum('extraction_status', ['processing', 'needs_review', 'approved', 'rejected']);

export const levels = pgTable('levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ratePerHour: numeric('rate_per_hour', { precision: 10, scale: 2 }).notNull(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  standardShiftHours: numeric('standard_shift_hours', { precision: 5, scale: 2 }).notNull(),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  levelId: uuid('level_id').notNull().references(() => levels.id),
  revenuePercent: numeric('revenue_percent', { precision: 6, scale: 4 }).notNull().default('0'),
  cognitoSub: text('cognito_sub').unique(),
  active: boolean('active').notNull().default(true),
});

export const shifts = pgTable(
  'shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    workDate: date('work_date').notNull(),
    status: shiftStatus('status').notNull().default('requested'),
    source: shiftSource('source').notNull().default('native'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.employeeId, t.workDate)],
);

export const dailyRevenue = pgTable(
  'daily_revenue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    locationId: uuid('location_id').notNull().references(() => locations.id),
    revenueDate: date('revenue_date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    source: revenueSource('source').notNull().default('manual'),
    status: revenueStatus('status').notNull().default('approved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.locationId, t.revenueDate)],
);

export const extractionJobs = pgTable('extraction_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: docType('doc_type').notNull(),
  s3Key: text('s3_key').notNull(),
  status: extractionStatus('status').notNull().default('processing'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  extractedJson: jsonb('extracted_json'),
  reviewedBy: text('reviewed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const salaryRuns = pgTable(
  'salary_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.periodStart, t.periodEnd)],
);

export const salaryRunLines = pgTable(
  'salary_run_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => salaryRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id),
    hourlyPay: numeric('hourly_pay', { precision: 12, scale: 2 }).notNull(),
    revenueShare: numeric('revenue_share', { precision: 12, scale: 2 }).notNull(),
    bonus: numeric('bonus', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [unique().on(t.runId, t.employeeId)],
);
```

- [ ] **Step 5: Write the test DB helper**

`packages/api/src/db/testDb.ts`:
```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { INIT_SQL } from '@salary/core/migrations';
import * as schema from '../schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Create an isolated in-process Postgres (PGlite) with the schema applied. */
export async function createTestDb(): Promise<{ client: PGlite; db: Db }> {
  const client = new PGlite();
  await client.exec(INIT_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}
```

- [ ] **Step 6: Write the failing schema round-trip test**

`packages/api/test/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees } from '../src/schema';

describe('drizzle schema against the core migration', () => {
  it('inserts and reads back a level, location, and employee', async () => {
    const { db } = await createTestDb();

    const [level] = await db
      .insert(levels)
      .values({ name: 'Junior', ratePerHour: '20.00' })
      .returning();
    await db.insert(locations).values({ name: 'Downtown', standardShiftHours: '8.00' });
    const [employee] = await db
      .insert(employees)
      .values({ name: 'Alice', levelId: level.id, revenuePercent: '0.0500' })
      .returning();

    const found = await db.select().from(employees).where(eq(employees.id, employee.id));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Alice');
    expect(found[0].revenuePercent).toBe('0.0500'); // NUMERIC comes back as a string
    expect(found[0].active).toBe(true);
  });

  it('enforces the employee-per-day uniqueness through drizzle inserts', async () => {
    const { db } = await createTestDb();
    const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '10.00' }).returning();
    const [loc] = await db.insert(locations).values({ name: 'Loc', standardShiftHours: '8.00' }).returning();
    const [emp] = await db.insert(employees).values({ name: 'Bob', levelId: level.id }).returning();

    const { shifts } = await import('../src/schema');
    await db.insert(shifts).values({ employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01' });
    await expect(
      db.insert(shifts).values({ employeeId: emp.id, locationId: loc.id, workDate: '2026-09-01' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails, then passes**

Run: `pnpm --filter @salary/api test`
Expected first: FAIL if any wiring is incomplete (e.g. `@salary/core/migrations` not resolvable, or schema mismatch). Once Steps 1–6 are all in place, re-run:
Run: `pnpm --filter @salary/api test`
Expected: PASS — both tests green (round-trip read and the uniqueness rejection).

- [ ] **Step 8: Commit**

```bash
git add packages/core/package.json packages/core/src/migrations.ts packages/api
git commit -m "Scaffold api package with drizzle schema and PGlite test db"
```

---

### Task 2: Token verifier + auth middleware

**Files:**
- Create: `packages/api/src/auth/types.ts`
- Create: `packages/api/src/auth/cognitoVerifier.ts`
- Create: `packages/api/src/auth/middleware.ts`
- Test: `packages/api/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (pure auth units).
- Produces:
  - `interface Principal { sub: string; groups: string[] }`
  - `interface TokenVerifier { verify(token: string): Promise<Principal> }`
  - `cognitoVerifier(cfg: { userPoolId: string; clientId: string }): TokenVerifier`
  - `authMiddleware(verifier: TokenVerifier): MiddlewareHandler` — sets `principal` on the context, or returns `401`.
  - `requireRole(...roles: string[]): MiddlewareHandler` — `403` if the principal lacks all listed roles.
  - `AppEnv` Hono type: `{ Variables: { principal: Principal } }`.

- [ ] **Step 1: Define the auth types**

`packages/api/src/auth/types.ts`:
```ts
export interface Principal {
  sub: string;
  groups: string[];
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

/** Hono environment: middleware populates `principal` after authentication. */
export type AppEnv = { Variables: { principal: Principal } };
```

- [ ] **Step 2: Write the failing auth middleware test**

`packages/api/test/auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, requireRole } from '../src/auth/middleware';
import type { AppEnv, TokenVerifier } from '../src/auth/types';

function fakeVerifier(map: Record<string, { sub: string; groups: string[] }>): TokenVerifier {
  return {
    async verify(token) {
      const principal = map[token];
      if (!principal) throw new Error('invalid token');
      return principal;
    },
  };
}

function appWith(verifier: TokenVerifier) {
  const app = new Hono<AppEnv>();
  app.use('*', authMiddleware(verifier));
  app.get('/whoami', (c) => c.json(c.get('principal')));
  app.get('/admin', requireRole('admin'), (c) => c.json({ ok: true }));
  return app;
}

const verifier = fakeVerifier({
  'mgr-token': { sub: 'u-mgr', groups: ['manager'] },
  'admin-token': { sub: 'u-admin', groups: ['admin'] },
});

describe('authMiddleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await appWith(verifier).request('/whoami');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Token x' } });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('sets the principal for a valid token', async () => {
    const res = await appWith(verifier).request('/whoami', { headers: { Authorization: 'Bearer mgr-token' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'u-mgr', groups: ['manager'] });
  });
});

describe('requireRole', () => {
  it('allows a principal that has the role', async () => {
    const res = await appWith(verifier).request('/admin', { headers: { Authorization: 'Bearer admin-token' } });
    expect(res.status).toBe(200);
  });

  it('forbids a principal missing the role', async () => {
    const res = await appWith(verifier).request('/admin', { headers: { Authorization: 'Bearer mgr-token' } });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test auth`
Expected: FAIL — `../src/auth/middleware` does not exist.

- [ ] **Step 4: Implement the middleware**

`packages/api/src/auth/middleware.ts`:
```ts
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, TokenVerifier } from './types';

/** Authenticate a Bearer token and attach the principal to the context. */
export function authMiddleware(verifier: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      const principal = await verifier.verify(header.slice('Bearer '.length));
      c.set('principal', principal);
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}

/** Require the principal to belong to at least one of the given Cognito groups. */
export function requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!roles.some((role) => principal.groups.includes(role))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}
```

- [ ] **Step 5: Implement the production Cognito verifier**

`packages/api/src/auth/cognitoVerifier.ts`:
```ts
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Principal, TokenVerifier } from './types';

/** Production verifier backed by Cognito's JWKS (access tokens). */
export function cognitoVerifier(cfg: { userPoolId: string; clientId: string }): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: cfg.userPoolId,
    tokenUse: 'access',
    clientId: cfg.clientId,
  });
  return {
    async verify(token: string): Promise<Principal> {
      const payload = await verifier.verify(token);
      const groups = (payload['cognito:groups'] as string[] | undefined) ?? [];
      return { sub: payload.sub, groups };
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test auth`
Expected: PASS — all 6 auth tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/auth packages/api/test/auth.test.ts
git commit -m "Add token verifier and Hono auth/role middleware"
```

---

### Task 3: App factory (health, me, error handling)

**Files:**
- Create: `packages/api/src/app.ts`
- Test: `packages/api/test/app.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1), `TokenVerifier`/`AppEnv`/auth middleware (Task 2).
- Produces:
  - `interface AppDeps { db: Db; verifier: TokenVerifier }`
  - `createApp(deps: AppDeps): Hono<AppEnv>` — mounts `GET /health` (public), applies auth to `/api/*`, mounts `GET /api/me` (returns the principal), and installs a JSON error handler. Later plans register their routes inside this factory.

- [ ] **Step 1: Write the failing app test**

`packages/api/test/app.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    throw new Error('bad');
  },
};

async function makeApp() {
  const { db } = await createTestDb();
  return createApp({ db, verifier });
}

describe('createApp', () => {
  it('serves an unauthenticated health check', async () => {
    const app = await makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('requires auth for /api/me', async () => {
    const app = await makeApp();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('returns the principal from /api/me when authenticated', async () => {
    const app = await makeApp();
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'u-mgr', groups: ['manager'] });
  });

  it('returns 404 JSON for an unknown route', async () => {
    const app = await makeApp();
    const res = await app.request('/api/does-not-exist', { headers: { Authorization: 'Bearer mgr' } });
    expect(res.status).toBe(404);
  });

  it('preserves the status of an intentional HTTPException thrown by a route', async () => {
    const app = await makeApp();
    app.get('/boom-http', () => {
      throw new HTTPException(409, { message: 'conflict' });
    });
    const res = await app.request('/boom-http');
    expect(res.status).toBe(409);
  });

  it('maps an unexpected error to a 500 without leaking its message', async () => {
    const app = await makeApp();
    app.get('/boom-raw', () => {
      throw new Error('secret db ARN leak');
    });
    const res = await app.request('/boom-raw');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal' });
    expect(JSON.stringify(body)).not.toContain('secret db ARN leak');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test app`
Expected: FAIL — `../src/app` does not exist.

- [ ] **Step 3: Implement the app factory**

`packages/api/src/app.ts`:
```ts
import { Hono } from 'hono';

import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/testDb';
import type { AppEnv, TokenVerifier } from './auth/types';
import { authMiddleware } from './auth/middleware';

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
}

/**
 * Build the API app. Dependency-injected so tests can supply a PGlite db and a
 * fake verifier. Later plans register their route groups where indicated.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', authMiddleware(deps.verifier));
  app.get('/api/me', (c) => c.json(c.get('principal')));

  // Route groups from later plans mount here, e.g.:
  //   app.route('/api/levels', createLevelRoutes(deps));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    // Preserve intentional HTTP errors thrown by routes/validators.
    if (err instanceof HTTPException) return err.getResponse();
    // Never leak raw error detail (SQL, ARNs) to clients; log server-side.
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
```

Note: `deps.db` is intentionally unused until later plans register data routes; it is part of the stable factory signature. Reference it to satisfy `noUnusedParameters` only if that flag is on — it is not in this tsconfig, so no placeholder use is needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @salary/api test app`
Expected: PASS — all 4 app tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/app.ts packages/api/test/app.test.ts
git commit -m "Add Hono app factory with health, me, and error handling"
```

---

### Task 4: Production DB, Lambda entrypoint, barrel + typecheck gate

**Files:**
- Create: `packages/api/src/db/prodDb.ts`
- Create: `packages/api/src/handler.ts`
- Create: `packages/api/src/index.ts`
- Test: `packages/api/test/config.test.ts`

**Interfaces:**
- Consumes: `createApp` (Task 3), `cognitoVerifier` (Task 2), schema (Task 1).
- Produces:
  - `createProdDb(cfg): Db` — a Drizzle RDS Data API client over the schema.
  - `readEnvConfig(env): ApiConfig` — parse/validate required env vars with Zod; throws a clear error listing what's missing.
  - `handler` — the API Gateway Lambda handler (via `hono/aws-lambda`).
  - `index.ts` re-exports `createApp`, `createTestDb`, `schema`, and auth symbols for consumers/tests.

- [ ] **Step 1: Write the failing config test**

`packages/api/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readEnvConfig } from '../src/db/prodDb';

const complete = {
  AWS_REGION: 'us-east-1',
  DB_RESOURCE_ARN: 'arn:aws:rds:us-east-1:1:cluster:c',
  DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:s',
  DB_NAME: 'salary',
  COGNITO_USER_POOL_ID: 'us-east-1_abc',
  COGNITO_CLIENT_ID: 'client123',
};

describe('readEnvConfig', () => {
  it('parses a complete environment', () => {
    const cfg = readEnvConfig(complete);
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.dbName).toBe('salary');
    expect(cfg.userPoolId).toBe('us-east-1_abc');
  });

  it('throws listing the missing variable', () => {
    const { DB_NAME, ...missing } = complete;
    expect(() => readEnvConfig(missing)).toThrow(/DB_NAME/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @salary/api test config`
Expected: FAIL — `../src/db/prodDb` does not exist.

- [ ] **Step 3: Implement the production DB and config**

`packages/api/src/db/prodDb.ts`:
```ts
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { z } from 'zod';
import * as schema from '../schema';
import type { Db } from './testDb';

const envSchema = z.object({
  AWS_REGION: z.string().min(1),
  DB_RESOURCE_ARN: z.string().min(1),
  DB_SECRET_ARN: z.string().min(1),
  DB_NAME: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
});

export interface ApiConfig {
  region: string;
  resourceArn: string;
  secretArn: string;
  dbName: string;
  userPoolId: string;
  clientId: string;
}

/** Parse and validate the runtime environment; throws listing any missing keys. */
export function readEnvConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid API configuration; check env vars: ${keys}`);
  }
  const e = parsed.data;
  return {
    region: e.AWS_REGION,
    resourceArn: e.DB_RESOURCE_ARN,
    secretArn: e.DB_SECRET_ARN,
    dbName: e.DB_NAME,
    userPoolId: e.COGNITO_USER_POOL_ID,
    clientId: e.COGNITO_CLIENT_ID,
  };
}

/** Drizzle database backed by the Aurora Serverless v2 RDS Data API. */
export function createProdDb(cfg: ApiConfig): Db {
  const client = new RDSDataClient({ region: cfg.region });
  return drizzle(client, {
    database: cfg.dbName,
    resourceArn: cfg.resourceArn,
    secretArn: cfg.secretArn,
    schema,
  }) as unknown as Db;
}
```

Note on the `as unknown as Db` cast: `Db` is defined over the PGlite driver for test convenience; the Data API driver exposes the same query surface for our schema. The cast keeps one shared `Db` type across test and prod without leaking driver generics into every consumer. If a later plan hits a real type divergence, widen `Db` to a driver-agnostic `PgDatabase` union at that point.

- [ ] **Step 4: Implement the Lambda handler and barrel**

`packages/api/src/handler.ts`:
```ts
import { handle } from 'hono/aws-lambda';
import { createApp } from './app';
import { cognitoVerifier } from './auth/cognitoVerifier';
import { createProdDb, readEnvConfig } from './db/prodDb';

const config = readEnvConfig(process.env);
const app = createApp({
  db: createProdDb(config),
  verifier: cognitoVerifier({ userPoolId: config.userPoolId, clientId: config.clientId }),
});

export const handler = handle(app);
```

`packages/api/src/index.ts`:
```ts
export { createApp, type AppDeps } from './app';
export { createTestDb, type Db } from './db/testDb';
export { readEnvConfig, createProdDb, type ApiConfig } from './db/prodDb';
export { authMiddleware, requireRole } from './auth/middleware';
export { cognitoVerifier } from './auth/cognitoVerifier';
export type { Principal, TokenVerifier, AppEnv } from './auth/types';
export * as schema from './schema';
```

- [ ] **Step 5: Run the config test and full suite**

Run: `pnpm --filter @salary/api test`
Expected: PASS — schema, auth, app, and config tests all green.

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @salary/api typecheck`
Expected: PASS — `tsc --noEmit` reports no errors. (If the `hono/aws-lambda` import or the Data API driver types error, resolve them here — do not suppress with `any` beyond the single documented `Db` cast.)

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/db/prodDb.ts packages/api/src/handler.ts packages/api/src/index.ts packages/api/test/config.test.ts
git commit -m "Add prod RDS Data API db, env config, and Lambda handler"
```

---

## Self-Review

**Spec coverage (against `2026-08-03-salary-calculator-design.md` §7 and §2):**
- Single API Lambda + API Gateway, Hono router → Task 3 (`createApp`) + Task 4 (`handler` via `hono/aws-lambda`).
- Cognito JWT authorizer, three roles → Task 2 (verifier + `authMiddleware` + `requireRole`), Task 4 (prod `cognitoVerifier`).
- Aurora Serverless v2 via RDS Data API → Task 4 (`createProdDb`); PGlite for tests → Task 1 (`createTestDb`).
- Data model consumed by the API → Task 1 (Drizzle schema mirrors `0001_init.sql`, verified by applying that SQL to PGlite).
- Consumes `@salary/core` → Task 1 (`@salary/core/migrations`); the calculation engine is consumed by a later plan's calc endpoint, not here.
- Endpoint groups (levels/locations/employees/shifts/revenue/salary-runs) → explicitly deferred to plans 2b–2d, which mount routes in `createApp`.

**Placeholder scan:** No TBD/TODO. The one intentional "unused for now" is `AppDeps.db`, documented in Task 3 with the reason and the note that `noUnusedParameters` is off.

**Type consistency:** `Db` is defined once in Task 1 and reused by `createApp` (Task 3) and `createProdDb` (Task 4, with a documented cast). `Principal`/`TokenVerifier`/`AppEnv` defined in Task 2 and consumed by Tasks 3–4. Enum values in the Drizzle schema (Task 1) match `0001_init.sql` and the `@salary/core` string-literal unions verbatim. Numeric-as-string is called out in Global Constraints and asserted in the Task 1 test (`revenuePercent === '0.0500'`).