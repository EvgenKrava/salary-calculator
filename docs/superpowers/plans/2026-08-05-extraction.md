# Document Extraction Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn hand-written daily revenue reports and schedules (phone photos and scanned PDFs) into reviewable data: an S3 upload triggers a Lambda that asks Claude on Bedrock to read the document into a structured schema, then stages high-confidence results and queues everything else for a manager to check.

**Architecture:** A new `@salary/extraction` package holding **application code only** — Terraform for this Lambda is owned by the concurrent infra plan, against the contract at `docs/contracts/extraction-lambda.md`. Three layers: (1) a **pure** `buildExtractionRequest` / `parseExtractionResponse` pair that has no AWS or network dependency and carries all the schema and confidence logic, so the risky part is unit-testable; (2) a thin **Bedrock client** wrapper; (3) the **handler** that reads S3, calls Bedrock, and writes `extraction_jobs` + staged rows over the RDS Data API. Plus API routes so a manager can work the review queue.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`), `@aws-sdk/client-s3`, `@aws-sdk/client-rds-data`, Hono/Drizzle/Zod for the review routes.

## Global Constraints

- **Node** `>=20`, **pnpm**. TypeScript strict, ESM, extensionless relative imports.
- **This package owns NO Terraform.** Do not create or edit anything under `infra/`. The deployment contract (bundle path, handler name, env vars, IAM already granted) is `docs/contracts/extraction-lambda.md` — read it, build to it, and if something genuinely does not fit, report it rather than adding Terraform.
- **Claude API specifics, confirmed against the `claude-api` skill** (design spec §6):
  - Client `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`; model **`anthropic.claude-opus-5`** (Bedrock IDs carry the `anthropic.` prefix); auth via `AWS_BEARER_TOKEN_BEDROCK`.
  - **Thinking is on by default** on Opus 5, and `max_tokens` caps thinking **plus** response text — size it with headroom or responses truncate mid-answer.
  - `budget_tokens`, `temperature`, `top_p`, `top_k` all return **400**. Use `output_config.effort`.
  - Structured output via **`output_config.format`** with a `json_schema`; the deprecated top-level `output_format` must not be used. Assistant-turn prefills also 400.
  - Images: `{type:'image', source:{type:'base64', media_type, data}}`. PDFs: `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}` placed **before** the text block. Base64 must contain **no newlines**.
  - A refusal returns **HTTP 200** with `stop_reason: 'refusal'` and possibly **empty `content`** — check `stop_reason` before indexing `content[0]`, or a scanned document that trips a classifier crashes the Lambda.
- **Never invent data.** A document the model cannot read never produces a guessed number. Payroll data is only ever *staged* by this pipeline; a human confirms it.
  - **Two distinct outcomes, resolved during implementation** (this bullet originally said `needs_review` for both, which contradicted the plan's own Task 3 code):
    - **Read, but not confidently** (low document or row confidence) → `needs_review`. There is something for a human to check, so it belongs in the queue.
    - **Not read at all** (refusal, truncation, malformed JSON, schema violation, unsupported or oversized media) → `rejected`, carrying the reason *and the raw response text*. There are no rows to review; the document needs re-uploading, not correcting. Putting these in `needs_review` would fill the manager's queue with items that cannot be acted on.
  - Both record the model's `notes` and, for unusable outcomes, the raw response, so the reason is always visible in the UI.
- **Every invocation writes an `extraction_jobs` row**, including failures and refusals, so nothing is silently dropped.
- **No real client documents in the repo.** `docs/*.xlsx` is gitignored; tests use small synthetic fixtures generated in-process. Never commit a real photo or scan.

---

### Task 1: Package scaffold and the pure request builder

**Files:**
- Create: `packages/extraction/package.json`
- Create: `packages/extraction/tsconfig.json`
- Create: `packages/extraction/vitest.config.ts`
- Create: `packages/extraction/src/schemas.ts`
- Create: `packages/extraction/src/buildRequest.ts`
- Test: `packages/extraction/test/buildRequest.test.ts`

**Interfaces:**
- Produces:
  - `REVENUE_SCHEMA` / `SCHEDULE_SCHEMA` — JSON Schemas for `output_config.format`.
  - `type DocType = 'revenue' | 'schedule'`
  - `buildExtractionRequest(input: { docType: DocType; media: { mediaType: string; base64: string } }): MessageRequest` — pure; returns the exact request body (model, `max_tokens`, `output_config`, `messages`) with no network call.

- [ ] **Step 1: Create the package config**

`packages/extraction/package.json`:
```json
{
  "name": "@salary/extraction",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "bundle": "esbuild src/handler.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/extract.js --external:@aws-sdk/*"
  },
  "dependencies": {
    "@anthropic-ai/bedrock-sdk": "^0.24.0",
    "@aws-sdk/client-rds-data": "^3.665.0",
    "@aws-sdk/client-s3": "^3.665.0",
    "@salary/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.145",
    "@types/node": "^22.7.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.2"
  }
}
```

`packages/extraction/tsconfig.json`:
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

`packages/extraction/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

Run: `pnpm install`
Expected: the workspace picks up `packages/extraction` (the root `pnpm-workspace.yaml` already globs `packages/*`) and resolves the deps.

- [ ] **Step 2: Write the failing request-builder test**

`packages/extraction/test/buildRequest.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildExtractionRequest } from '../src/buildRequest';

const IMAGE = { mediaType: 'image/jpeg', base64: 'AAAA' };
const PDF = { mediaType: 'application/pdf', base64: 'BBBB' };

describe('buildExtractionRequest', () => {
  it('targets the Bedrock-prefixed Opus 5 model', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    expect(req.model).toBe('anthropic.claude-opus-5');
  });

  it('never sends parameters Opus 5 rejects with a 400', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE }) as Record<string, unknown>;
    // Each of these returns HTTP 400 on Opus 5 — see the claude-api skill.
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('top_p');
    expect(req).not.toHaveProperty('top_k');
    expect(req).not.toHaveProperty('output_format'); // deprecated in favour of output_config
    expect(JSON.stringify(req)).not.toContain('budget_tokens');
  });

  it('requests structured output via output_config.format', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema).toMatchObject({ type: 'object' });
  });

  it('leaves max_tokens headroom because thinking shares the budget', () => {
    // Opus 5 thinks by default and max_tokens caps thinking + response text together.
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    expect(req.max_tokens).toBeGreaterThanOrEqual(8000);
  });

  it('sends an image as an image block', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    const blocks = req.messages[0].content;
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
  });

  it('sends a PDF as a document block placed before the text block', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: PDF });
    const blocks = req.messages[0].content;
    expect(blocks[0].type).toBe('document');
    expect(blocks[blocks.length - 1].type).toBe('text');
  });

  it('rejects base64 containing newlines', () => {
    // The API rejects newline-wrapped base64; catching it here gives a clear error.
    expect(() =>
      buildExtractionRequest({ docType: 'revenue', media: { mediaType: 'image/png', base64: 'AA\nAA' } }),
    ).toThrow(/newline/i);
  });

  it('rejects an unsupported media type', () => {
    expect(() =>
      buildExtractionRequest({ docType: 'revenue', media: { mediaType: 'image/tiff', base64: 'AA' } }),
    ).toThrow(/unsupported/i);
  });

  it('uses a different schema per document type', () => {
    const revenue = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    const schedule = buildExtractionRequest({ docType: 'schedule', media: IMAGE });
    expect(revenue.output_config.format.schema).not.toEqual(schedule.output_config.format.schema);
  });

  it('asks for a confidence signal and forbids guessing', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    const schema = req.output_config.format.schema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('confidence');
    const prompt = JSON.stringify(req.messages);
    expect(prompt.toLowerCase()).toMatch(/do not guess|never guess/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @salary/extraction test buildRequest`
Expected: FAIL — `../src/buildRequest` does not exist.

- [ ] **Step 4: Write the schemas**

`packages/extraction/src/schemas.ts`:
```ts
export type DocType = 'revenue' | 'schedule';

/**
 * Structured-output schemas for `output_config.format`.
 *
 * Two deliberate choices carried through both schemas:
 * - Every extracted row carries its own `confidence`, not just the document. One illegible
 *   figure on an otherwise clean page should send that row to review, not the whole page.
 * - Amounts and dates are strings, not numbers/dates. The model transcribes what it sees;
 *   parsing and validation happen in our code where a failure is visible, rather than
 *   being silently coerced by the model.
 */
export const REVENUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'confidence', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['locationName', 'date', 'amount', 'confidence'],
        properties: {
          locationName: { type: 'string', description: 'Location name or number as written' },
          date: { type: 'string', description: 'The date as written, e.g. "5" or "2026-05-05"' },
          amount: { type: 'string', description: 'The revenue figure exactly as written' },
          confidence: { type: 'number', description: '0-1 confidence for THIS row' },
        },
      },
    },
    confidence: { type: 'number', description: '0-1 confidence for the document overall' },
    notes: { type: 'string', description: 'Anything illegible, ambiguous, or unexpected' },
  },
} as const;

export const SCHEDULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'confidence', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['employeeName', 'date', 'locationName', 'confidence'],
        properties: {
          employeeName: { type: 'string', description: 'The name as written' },
          date: { type: 'string', description: 'The date as written' },
          locationName: { type: 'string', description: 'Location name or number as written' },
          startsAt: { type: 'string', description: 'HH:MM if the document states it, else empty' },
          endsAt: { type: 'string', description: 'HH:MM if the document states it, else empty' },
          confidence: { type: 'number', description: '0-1 confidence for THIS row' },
        },
      },
    },
    confidence: { type: 'number' },
    notes: { type: 'string' },
  },
} as const;

export function schemaFor(docType: DocType) {
  return docType === 'revenue' ? REVENUE_SCHEMA : SCHEDULE_SCHEMA;
}
```

- [ ] **Step 5: Write the request builder**

`packages/extraction/src/buildRequest.ts`:
```ts
import { schemaFor, type DocType } from './schemas';

const SUPPORTED_MEDIA = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/** Bedrock model IDs carry the `anthropic.` prefix; the bare ID 400s here. */
export const MODEL_ID = 'anthropic.claude-opus-5';

export interface ExtractionMedia {
  mediaType: string;
  base64: string;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  output_config: { effort: string; format: { type: 'json_schema'; schema: unknown } };
  messages: { role: 'user'; content: unknown[] }[];
}

const INSTRUCTIONS = `You are transcribing a hand-written document from a coffee-shop chain so a manager can verify it.

Transcribe only what is actually written. Do not guess, infer, or complete values that are not legible — an omitted row and a low confidence score are both far better than an invented number, because these figures determine what people are paid.

For every row, give a confidence between 0 and 1 for that specific row. Give a separate overall confidence for the document. Use the notes field for anything illegible, ambiguous, crossed out, or otherwise unexpected.

Copy amounts, dates, names and times exactly as they appear, as strings. Do not reformat, round, or convert them.`;

/**
 * Build the Bedrock request body for one document. Pure — no network, no AWS, no clock.
 *
 * Notable constraints encoded here (all confirmed against the claude-api skill):
 * - `max_tokens` is deliberately generous: Opus 5 thinks by default and thinking shares
 *   this budget with the response, so a tight value truncates the answer mid-JSON.
 * - No `temperature`/`top_p`/`top_k`/`budget_tokens` — each returns a 400 on Opus 5.
 * - PDFs and images use different block types, and the media block must precede the text.
 */
export function buildExtractionRequest(input: {
  docType: DocType;
  media: ExtractionMedia;
}): MessageRequest {
  const { docType, media } = input;

  if (!SUPPORTED_MEDIA.has(media.mediaType)) {
    throw new Error(`unsupported media type '${media.mediaType}' for extraction`);
  }
  if (/[\r\n]/.test(media.base64)) {
    throw new Error('base64 payload must not contain a newline — the API rejects it');
  }

  const mediaBlock =
    media.mediaType === 'application/pdf'
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: media.base64 },
        }
      : {
          type: 'image',
          source: { type: 'base64', media_type: media.mediaType, data: media.base64 },
        };

  return {
    model: MODEL_ID,
    max_tokens: 16000,
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: schemaFor(docType) },
    },
    messages: [
      {
        role: 'user',
        // Media first, text last — the documented ordering for document input.
        content: [mediaBlock, { type: 'text', text: INSTRUCTIONS }],
      },
    ],
  };
}
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter @salary/extraction test buildRequest`
Then: `pnpm --filter @salary/extraction typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add packages/extraction pnpm-lock.yaml
git commit -m "Add extraction package with the pure Bedrock request builder"
```

---

### Task 2: Response parsing, refusals, and confidence routing

**Files:**
- Create: `packages/extraction/src/parseResponse.ts`
- Test: `packages/extraction/test/parseResponse.test.ts`

**Interfaces:**
- Produces:
  - `type ExtractionOutcome = { kind: 'extracted'; rows: unknown[]; confidence: number; notes: string; route: 'approved' | 'needs_review' } | { kind: 'refused'; category: string | null } | { kind: 'unusable'; reason: string }`
  - `parseExtractionResponse(response: unknown, opts: { docType: DocType; threshold: number }): ExtractionOutcome` — pure.

This is where the pipeline's honesty lives: a refusal, a truncated answer, and a
low-confidence read must each be distinguishable, and none may become silent approved data.

- [ ] **Step 1: Write the failing parse test**

`packages/extraction/test/parseResponse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseExtractionResponse } from '../src/parseResponse';

const OPTS = { docType: 'revenue' as const, threshold: 0.85 };

function ok(payload: unknown, stop = 'end_turn') {
  return { stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const GOOD = {
  rows: [{ locationName: '1', date: '2026-05-05', amount: '1234.50', confidence: 0.95 }],
  confidence: 0.95,
  notes: '',
};

describe('parseExtractionResponse', () => {
  it('routes a high-confidence read to approved', () => {
    const out = parseExtractionResponse(ok(GOOD), OPTS);
    expect(out).toMatchObject({ kind: 'extracted', route: 'approved', confidence: 0.95 });
  });

  it('routes a low overall confidence to review', () => {
    const out = parseExtractionResponse(ok({ ...GOOD, confidence: 0.4 }), OPTS);
    expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
  });

  it('routes to review when ANY row is low confidence even if the document is high', () => {
    // One illegible figure must not ride in on a clean page's overall score.
    const payload = {
      ...GOOD,
      confidence: 0.97,
      rows: [
        { locationName: '1', date: '2026-05-05', amount: '1234.50', confidence: 0.97 },
        { locationName: '2', date: '2026-05-05', amount: '98?.00', confidence: 0.3 },
      ],
    };
    const out = parseExtractionResponse(ok(payload), OPTS);
    expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
  });

  it('routes an empty-row read to review, never approved', () => {
    const out = parseExtractionResponse(ok({ rows: [], confidence: 0.99, notes: 'blank page' }), OPTS);
    expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
  });

  it('detects a refusal without touching content[0]', () => {
    // A refusal is HTTP 200 with possibly-empty content; indexing content[0] would throw.
    const out = parseExtractionResponse(
      { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
      OPTS,
    );
    expect(out).toEqual({ kind: 'refused', category: 'cyber' });
  });

  it('treats a refusal with null stop_details as a refusal', () => {
    const out = parseExtractionResponse({ stop_reason: 'refusal', content: [] }, OPTS);
    expect(out).toEqual({ kind: 'refused', category: null });
  });

  it('reports a truncated response as unusable rather than parsing half the JSON', () => {
    const out = parseExtractionResponse(
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"rows":[{"loc' }] },
      OPTS,
    );
    expect(out).toMatchObject({ kind: 'unusable' });
    expect((out as { reason: string }).reason).toMatch(/truncat|max_tokens/i);
  });

  it('reports malformed JSON as unusable', () => {
    const out = parseExtractionResponse(
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
      OPTS,
    );
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  it('reports a response with no text block as unusable', () => {
    const out = parseExtractionResponse({ stop_reason: 'end_turn', content: [] }, OPTS);
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  it('reports a schema-violating payload as unusable', () => {
    const out = parseExtractionResponse(ok({ rows: 'not an array', confidence: 0.9 }), OPTS);
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  it('clamps a nonsense confidence rather than trusting it', () => {
    const out = parseExtractionResponse(ok({ ...GOOD, confidence: 5 }), OPTS);
    // A model-reported 5 must not be read as "very confident" — clamp, then route.
    expect((out as { confidence: number }).confidence).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @salary/extraction test parseResponse`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the parser**

`packages/extraction/src/parseResponse.ts`:
```ts
import { z } from 'zod';
import type { DocType } from './schemas';

const rowBase = z.object({ confidence: z.number() }).passthrough();

const payloadSchema = z.object({
  rows: z.array(rowBase),
  confidence: z.number(),
  notes: z.string().optional().default(''),
});

export type ExtractionOutcome =
  | {
      kind: 'extracted';
      rows: unknown[];
      confidence: number;
      notes: string;
      route: 'approved' | 'needs_review';
    }
  | { kind: 'refused'; category: string | null }
  | { kind: 'unusable'; reason: string };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Turn a Bedrock response into a routing decision. Pure.
 *
 * The three outcomes are deliberately distinct, because conflating them is how bad payroll
 * data gets in:
 * - `refused`   — the model declined (HTTP 200, `stop_reason: 'refusal'`, content may be
 *                 EMPTY, so this is checked before content is ever indexed).
 * - `unusable`  — we got a response but cannot trust it: truncated, malformed, or
 *                 schema-violating. Never partially parsed.
 * - `extracted` — usable rows, routed to `approved` or `needs_review`.
 */
export function parseExtractionResponse(
  response: unknown,
  opts: { docType: DocType; threshold: number },
): ExtractionOutcome {
  const res = response as {
    stop_reason?: string;
    stop_details?: { category?: string | null } | null;
    content?: { type?: string; text?: string }[];
  };

  // Check the refusal FIRST — content may be empty and indexing it would throw.
  if (res?.stop_reason === 'refusal') {
    return { kind: 'refused', category: res.stop_details?.category ?? null };
  }

  if (res?.stop_reason === 'max_tokens') {
    return {
      kind: 'unusable',
      reason: 'response truncated (max_tokens) — raise max_tokens or lower effort',
    };
  }

  const text = res?.content?.find((b) => b?.type === 'text')?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: 'unusable', reason: 'response contained no text block' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unusable', reason: 'response was not valid JSON' };
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'unusable', reason: `payload did not match the schema: ${parsed.error.message}` };
  }

  const confidence = clamp01(parsed.data.confidence);
  const rows = parsed.data.rows;
  const lowestRow = rows.reduce((min, r) => Math.min(min, clamp01(r.confidence)), 1);

  // An empty read is never "approved" — a blank result with a high score is exactly the
  // case a human needs to look at.
  const route =
    rows.length > 0 && confidence >= opts.threshold && lowestRow >= opts.threshold
      ? 'approved'
      : 'needs_review';

  return { kind: 'extracted', rows, confidence, notes: parsed.data.notes, route };
}
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @salary/extraction test`
Then: `pnpm --filter @salary/extraction typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/extraction/src/parseResponse.ts packages/extraction/test/parseResponse.test.ts
git commit -m "Add extraction response parsing with refusal and confidence routing"
```

---

### Task 3: Bedrock client and the Lambda handler

**Files:**
- Create: `packages/extraction/src/bedrock.ts`
- Create: `packages/extraction/src/db.ts`
- Create: `packages/extraction/src/handler.ts`
- Create: `packages/extraction/src/index.ts`
- Test: `packages/extraction/test/handler.test.ts`

**Interfaces:**
- Consumes: `buildExtractionRequest` (Task 1), `parseExtractionResponse` (Task 2), the contract's env vars.
- Produces: `handler(event: S3Event)` — the Lambda entrypoint at `extract.handler`; and `HandlerDeps` for injection so the handler is testable without AWS.

- [ ] **Step 1: Write the failing handler test**

`packages/extraction/test/handler.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createHandler, type HandlerDeps } from '../src/handler';

function s3Event(key: string) {
  return {
    Records: [{ s3: { bucket: { name: 'docs' }, object: { key } } }],
  } as never;
}

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    getObject: vi.fn(async () => ({ body: Buffer.from('fake-image-bytes'), contentType: 'image/jpeg' })),
    invokeModel: vi.fn(async () => ({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rows: [{ locationName: '1', date: '2026-05-05', amount: '1000.00', confidence: 0.95 }],
            confidence: 0.95,
            notes: '',
          }),
        },
      ],
    })),
    recordJob: vi.fn(async () => 'job-1'),
    threshold: 0.85,
    ...overrides,
  };
}

describe('extraction handler', () => {
  it('records an approved job for a high-confidence read', async () => {
    const d = deps();
    await createHandler(d)(s3Event('uploads/revenue/abc-report.jpg'));
    expect(d.recordJob).toHaveBeenCalledWith(
      expect.objectContaining({ docType: 'revenue', status: 'approved' }),
    );
  });

  it('derives the doc type from the key prefix', async () => {
    const d = deps();
    await createHandler(d)(s3Event('uploads/schedule/abc-rota.png'));
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ docType: 'schedule' }));
  });

  it('records needs_review when confidence is below the threshold', async () => {
    const d = deps({
      invokeModel: vi.fn(async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ rows: [{ confidence: 0.2 }], confidence: 0.2, notes: 'blurry' }) }],
      })),
    });
    await createHandler(d)(s3Event('uploads/revenue/x.jpg'));
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_review' }));
  });

  it('records a rejected job on a refusal instead of throwing', async () => {
    const d = deps({
      invokeModel: vi.fn(async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })),
    });
    await expect(createHandler(d)(s3Event('uploads/revenue/x.jpg'))).resolves.not.toThrow();
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('records a rejected job when Bedrock throws, and does not crash the invocation', async () => {
    const d = deps({
      invokeModel: vi.fn(async () => {
        throw new Error('ThrottlingException');
      }),
    });
    await expect(createHandler(d)(s3Event('uploads/revenue/x.jpg'))).resolves.not.toThrow();
    expect(d.recordJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', error: expect.stringContaining('Throttling') }),
    );
  });

  it('records a rejected job for an unknown key prefix without calling Bedrock', async () => {
    const d = deps();
    await createHandler(d)(s3Event('uploads/mystery/x.jpg'));
    expect(d.invokeModel).not.toHaveBeenCalled();
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('records a rejected job for an unsupported media type', async () => {
    const d = deps({
      getObject: vi.fn(async () => ({ body: Buffer.from('x'), contentType: 'image/tiff' })),
    });
    await createHandler(d)(s3Event('uploads/revenue/x.tiff'));
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('processes every record in a multi-record event', async () => {
    const d = deps();
    const event = {
      Records: [
        { s3: { bucket: { name: 'docs' }, object: { key: 'uploads/revenue/a.jpg' } } },
        { s3: { bucket: { name: 'docs' }, object: { key: 'uploads/revenue/b.jpg' } } },
      ],
    } as never;
    await createHandler(d)(event);
    expect(d.recordJob).toHaveBeenCalledTimes(2);
  });

  it('sends base64 with no newlines to the model', async () => {
    const d = deps({
      // A long buffer would be newline-wrapped by some encoders; ours must not be.
      getObject: vi.fn(async () => ({ body: Buffer.alloc(4096, 7), contentType: 'image/png' })),
    });
    await createHandler(d)(s3Event('uploads/revenue/big.png'));
    const req = (d.invokeModel as unknown as { mock: { calls: [{ messages: { content: { source?: { data?: string } }[] }[] }][] } }).mock.calls[0][0];
    const data = req.messages[0].content[0].source?.data ?? '';
    expect(data).not.toMatch(/[\r\n]/);
  });

  it('url-decodes the S3 key before fetching', async () => {
    // S3 event keys are URL-encoded; a space arrives as '+' or %20.
    const d = deps();
    await createHandler(d)(s3Event('uploads/revenue/my+report%20scan.jpg'));
    expect(d.getObject).toHaveBeenCalledWith('docs', 'uploads/revenue/my report scan.jpg');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @salary/extraction test handler`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the Bedrock and DB adapters**

`packages/extraction/src/bedrock.ts`:
```ts
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

/**
 * Bedrock client for the extraction Lambda.
 *
 * Auth is the `AWS_BEARER_TOKEN_BEDROCK` bearer token (a long-lived Bedrock API key) read
 * from the environment by the SDK — not SigV4 access keys. `AWS_REGION` is populated by
 * the Lambda runtime; `AWS_REGION_NAME` is the contract's explicit fallback because
 * `AWS_REGION` is reserved and cannot be set by Terraform.
 */
export function createBedrockClient() {
  const region = process.env.AWS_REGION_NAME ?? process.env.AWS_REGION;
  if (!region) throw new Error('AWS_REGION_NAME (or AWS_REGION) must be set');
  return new AnthropicBedrockMantle({ awsRegion: region });
}

export async function invokeModel(client: AnthropicBedrockMantle, request: unknown): Promise<unknown> {
  // The request body is built by buildExtractionRequest; the SDK forwards unknown keys, so
  // output_config passes through even where the typings lag.
  return client.messages.create(request as never);
}
```

`packages/extraction/src/db.ts`:
```ts
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

export interface JobRecord {
  docType: 'revenue' | 'schedule';
  s3Key: string;
  status: 'approved' | 'needs_review' | 'rejected';
  confidence: number | null;
  extracted: unknown;
  error?: string;
}

/**
 * Write one `extraction_jobs` row per invocation — including failures and refusals, so a
 * document is never silently dropped. Staged rows are written by the manager's review
 * action (the API routes), not here: this pipeline only ever *proposes* payroll data.
 */
export function createJobRecorder() {
  const region = process.env.AWS_REGION_NAME ?? process.env.AWS_REGION;
  const client = new RDSDataClient({ region });
  const resourceArn = process.env.DB_RESOURCE_ARN!;
  const secretArn = process.env.DB_SECRET_ARN!;
  const database = process.env.DB_NAME!;

  return async function recordJob(job: JobRecord): Promise<string> {
    const result = await client.send(
      new ExecuteStatementCommand({
        resourceArn,
        secretArn,
        database,
        sql: `INSERT INTO extraction_jobs (doc_type, s3_key, status, confidence, extracted_json)
              VALUES (:docType::doc_type, :s3Key, :status::extraction_status, :confidence, :extracted::jsonb)
              RETURNING id`,
        parameters: [
          { name: 'docType', value: { stringValue: job.docType } },
          { name: 's3Key', value: { stringValue: job.s3Key } },
          { name: 'status', value: { stringValue: job.status } },
          job.confidence === null
            ? { name: 'confidence', value: { isNull: true } }
            : { name: 'confidence', value: { doubleValue: job.confidence } },
          {
            name: 'extracted',
            value: { stringValue: JSON.stringify({ rows: job.extracted, error: job.error ?? null }) },
          },
        ],
      }),
    );
    return result.records?.[0]?.[0]?.stringValue ?? '';
  };
}
```

Note: the `extraction_jobs` enum values are `processing | needs_review | approved | rejected`
per migration `0001`. This handler writes the three terminal states; `processing` is unused
because the whole extraction happens inside one invocation. If the Data API rejects the
`::doc_type` casts, replace them with the plain string and let Postgres coerce — report
which form you used.

- [ ] **Step 4: Write the handler**

`packages/extraction/src/handler.ts`:
```ts
import type { S3Event } from 'aws-lambda';
import { buildExtractionRequest } from './buildRequest';
import { parseExtractionResponse } from './parseResponse';
import type { DocType } from './schemas';
import { createBedrockClient, invokeModel } from './bedrock';
import { createJobRecorder, type JobRecord } from './db';

export interface HandlerDeps {
  getObject: (bucket: string, key: string) => Promise<{ body: Buffer; contentType: string }>;
  invokeModel: (request: unknown) => Promise<unknown>;
  recordJob: (job: JobRecord) => Promise<string>;
  threshold: number;
}

function docTypeFromKey(key: string): DocType | null {
  // Contract: uploads/<docType>/<uuid>-<filename>
  const match = /^uploads\/(revenue|schedule)\//.exec(key);
  return match ? (match[1] as DocType) : null;
}

/**
 * Dependency-injected so the whole flow is testable without AWS or Bedrock.
 *
 * The invariant this function protects: **every record produces exactly one
 * extraction_jobs row.** A refusal, a throttle, a bad key, an unreadable media type — all
 * become a `rejected` row rather than a thrown error, because a Lambda that throws leaves
 * the manager with a document that vanished and no queue entry explaining why.
 */
export function createHandler(deps: HandlerDeps) {
  return async function handler(event: S3Event): Promise<void> {
    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      // S3 event keys are URL-encoded, and '+' means space.
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

      const docType = docTypeFromKey(key);
      if (!docType) {
        await deps.recordJob({
          docType: 'revenue',
          s3Key: key,
          status: 'rejected',
          confidence: null,
          extracted: null,
          error: `key does not match uploads/<revenue|schedule>/: ${key}`,
        });
        continue;
      }

      try {
        const object = await deps.getObject(bucket, key);
        const request = buildExtractionRequest({
          docType,
          media: {
            mediaType: object.contentType,
            // 'base64' never inserts line breaks; explicit for the API's no-newline rule.
            base64: object.body.toString('base64'),
          },
        });

        const response = await deps.invokeModel(request);
        const outcome = parseExtractionResponse(response, { docType, threshold: deps.threshold });

        if (outcome.kind === 'refused') {
          await deps.recordJob({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: `model refused (category: ${outcome.category ?? 'unknown'})`,
          });
          continue;
        }

        if (outcome.kind === 'unusable') {
          await deps.recordJob({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: outcome.reason,
          });
          continue;
        }

        await deps.recordJob({
          docType,
          s3Key: key,
          status: outcome.route,
          confidence: outcome.confidence,
          extracted: outcome.rows,
        });
      } catch (err) {
        await deps.recordJob({
          docType,
          s3Key: key,
          status: 'rejected',
          confidence: null,
          extracted: null,
          error: (err as Error).message,
        });
      }
    }
  };
}

/** The Lambda entrypoint named by the deployment contract (`extract.handler`). */
export const handler = async (event: S3Event): Promise<void> => {
  const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION_NAME ?? process.env.AWS_REGION });
  const bedrock = createBedrockClient();
  const recordJob = createJobRecorder();

  return createHandler({
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = Buffer.from(await res.Body!.transformToByteArray());
      return { body, contentType: res.ContentType ?? 'application/octet-stream' };
    },
    invokeModel: (request) => invokeModel(bedrock, request),
    recordJob,
    threshold: Number(process.env.CONFIDENCE_THRESHOLD ?? '0.85'),
  })(event);
};
```

`packages/extraction/src/index.ts`:
```ts
export { buildExtractionRequest, MODEL_ID } from './buildRequest';
export { parseExtractionResponse } from './parseResponse';
export { REVENUE_SCHEMA, SCHEDULE_SCHEMA, schemaFor } from './schemas';
export type { DocType } from './schemas';
export type { ExtractionOutcome } from './parseResponse';
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @salary/extraction test`
Then: `pnpm --filter @salary/extraction typecheck`
Then: `pnpm --filter @salary/extraction bundle`
Expected: tests pass, typecheck clean, and `dist/extract.js` is produced (the contract's
bundle path). If the Bedrock SDK's typings reject the `output_config` key, use a single
narrow cast at that call site (there is precedent in the repo) rather than loosening the
request builder's types — and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add packages/extraction/src packages/extraction/test/handler.test.ts
git commit -m "Add Bedrock client, job recorder, and the S3-triggered extraction handler"
```

---

### Task 4: Review-queue API routes

**Files:**
- Create: `packages/api/src/routes/extractionJobs.ts`
- Modify: `packages/api/src/app.ts` (mount)
- Test: `packages/api/test/extraction-jobs.test.ts`

**Interfaces:**
- Consumes: `Db`, `requireRole`, `readJson`/`getOr404`, the `extractionJobs` table.
- Produces: `createExtractionJobRoutes(db)` at `/api/extraction-jobs`, manager/admin:
  - `GET /` — list, optional `?status=` filter.
  - `GET /:id` — one job with its extracted payload.
  - `POST /:id/approve` — mark reviewed and approved (the manager has checked it).
  - `POST /:id/reject` — mark rejected with a reason.

This closes the human-in-the-loop: extraction *proposes*, a manager *confirms*. Committing
the confirmed rows into `daily_revenue`/`shifts` is deliberately **not** in this task — see
the note at the end.

- [ ] **Step 1: Write the failing test**

`packages/api/test/extraction-jobs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { extractionJobs } from '../src/schema';
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
  const [job] = await db
    .insert(extractionJobs)
    .values({
      docType: 'revenue',
      s3Key: 'uploads/revenue/a.jpg',
      status: 'needs_review',
      confidence: '0.400',
      extractedJson: { rows: [{ locationName: '1', amount: '1000.00' }] },
    })
    .returning();
  return { app: createApp({ db, verifier }), job };
}

describe('extraction job review', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/extraction-jobs', { headers: EMP })).status).toBe(403);
  });

  it('lists jobs and filters by status', async () => {
    const { app } = await seed();
    expect((await (await app.request('/api/extraction-jobs', { headers: MGR })).json())).toHaveLength(1);
    const filtered = await app.request('/api/extraction-jobs?status=approved', { headers: MGR });
    expect(await filtered.json()).toHaveLength(0);
  });

  it('returns one job with its extracted payload', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}`, { headers: MGR });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ docType: 'revenue', status: 'needs_review' });
    expect(body.extracted).toBeTruthy();
  });

  it('approves a job and records who reviewed it', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}/approve`, {
      method: 'POST',
      headers: MGR,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
    expect(body.reviewedBy).toBe('u-mgr');
  });

  it('rejects a job with a reason', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}/reject`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ reason: 'photo unreadable' }),
    });
    expect((await res.json()).status).toBe('rejected');
  });

  it('404s unknown and malformed ids', async () => {
    const { app } = await seed();
    expect((await app.request('/api/extraction-jobs/not-a-uuid', { headers: MGR })).status).toBe(404);
    expect(
      (await app.request('/api/extraction-jobs/00000000-0000-0000-0000-000000000000', { headers: MGR })).status,
    ).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @salary/api test extraction-jobs`
Expected: FAIL — routes not mounted.

- [ ] **Step 3: Write the routes**

`packages/api/src/routes/extractionJobs.ts`:
```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { extractionJobs } from '../schema';

const rejectSchema = z.object({ reason: z.string().min(1) });

type JobRow = typeof extractionJobs.$inferSelect;
function toDto(row: JobRow) {
  return {
    id: row.id,
    docType: row.docType,
    s3Key: row.s3Key,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    extracted: row.extractedJson,
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
  };
}

export function createExtractionJobRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!id || !z.string().uuid().safeParse(id).success) {
      throw new HTTPException(404, { message: 'extraction job not found' });
    }
    return id;
  }

  routes.get('/', async (c) => {
    const filters: SQL[] = [];
    const status = c.req.query('status');
    if (
      status === 'processing' ||
      status === 'needs_review' ||
      status === 'approved' ||
      status === 'rejected'
    ) {
      filters.push(eq(extractionJobs.status, status));
    }
    const rows = filters.length
      ? await db.select().from(extractionJobs).where(and(...filters))
      : await db.select().from(extractionJobs);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const rows = await db.select().from(extractionJobs).where(eq(extractionJobs.id, id));
    return c.json(toDto(getOr404(rows, 'extraction job not found')));
  });

  // Approving records WHO approved it. This is the human half of the human-in-the-loop —
  // the extraction only ever proposed this data.
  routes.post('/:id/approve', async (c) => {
    const id = idParam(c);
    const [row] = await db
      .update(extractionJobs)
      .set({ status: 'approved', reviewedBy: c.get('principal').sub, updatedAt: new Date() })
      .where(eq(extractionJobs.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'extraction job not found' });
    return c.json(toDto(row));
  });

  routes.post('/:id/reject', async (c) => {
    const id = idParam(c);
    const body = await readJson(c, rejectSchema);
    const [existing] = await db.select().from(extractionJobs).where(eq(extractionJobs.id, id));
    if (!existing) throw new HTTPException(404, { message: 'extraction job not found' });
    const payload = (existing.extractedJson ?? {}) as Record<string, unknown>;
    const [row] = await db
      .update(extractionJobs)
      .set({
        status: 'rejected',
        reviewedBy: c.get('principal').sub,
        // Keep the reason with the job so the queue explains itself later.
        extractedJson: { ...payload, rejectionReason: body.reason },
        updatedAt: new Date(),
      })
      .where(eq(extractionJobs.id, id))
      .returning();
    return c.json(toDto(row));
  });

  return routes;
}
```

- [ ] **Step 4: Mount the routes**

In `packages/api/src/app.ts`, add the import next to the other route imports:
```ts
import { createExtractionJobRoutes } from './routes/extractionJobs';
```
and mount it after the existing groups:
```ts
  app.route('/api/extraction-jobs', createExtractionJobRoutes(deps.db));
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @salary/api test`
Then: `pnpm -r typecheck`
Expected: the new suite passes and every existing API test still passes.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/extractionJobs.ts packages/api/src/app.ts packages/api/test/extraction-jobs.test.ts
git commit -m "Add extraction review-queue routes"
```

**Deliberately out of scope:** committing an approved job's rows into `daily_revenue` /
`shifts`. That needs name→employee and location-name→location resolution — exactly what the
merged schedule importer already solved (`schedule_name_map`, location matching) — and
reusing that resolver is the right design rather than writing a second one here. Approving
marks the job reviewed; the commit step is a follow-up plan that wires the two together.

---

## Self-Review

**Spec coverage (design §6):**
- Photos and scanned PDFs → Task 1 (image vs document blocks, media-type allowlist).
- Two document types with different schemas → Task 1 (`REVENUE_SCHEMA`/`SCHEDULE_SCHEMA`).
- Bedrock via `AnthropicBedrockMantle`, `anthropic.claude-opus-5`, bearer token → Task 3.
- Structured output + confidence signal → Task 1 (`output_config.format`, per-row confidence).
- High confidence auto-staged, low confidence to `needs_review` → Task 2 routing.
- Manager reviews the queue → Task 4.
- S3 put event trigger → the infra plan, against `docs/contracts/extraction-lambda.md`.

**API-drift constraints encoded as tests, not comments:** the "never sends 400 parameters"
test would fail if someone re-added `temperature` or `budget_tokens`; the refusal test would
fail if the parser indexed `content[0]` first; the `max_tokens` test documents why the value
is large (thinking shares the budget).

**Placeholder scan:** No TBD/TODO. Three contingencies are explicit with a stated remedy and
a reporting requirement: Data API enum casts, the Bedrock SDK typings for `output_config`,
and the deliberately-deferred commit step.

**Type consistency:** `DocType` is defined once in `schemas.ts` and flows through the
builder, parser, handler, and DB record. The handler is dependency-injected so no test needs
AWS. Bundle path and handler name match the deployment contract exactly.
