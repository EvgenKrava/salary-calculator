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
