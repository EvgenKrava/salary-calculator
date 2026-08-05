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

/**
 * Read a model-reported confidence, treating anything outside 0–1 as untrustworthy.
 *
 * **Do not replace this with a clamp.** Clamping saturates *upward*: a model that reports
 * confidence as a percentage (`20` meaning 20%) would become `1.0`, clear the threshold, and
 * be auto-approved — the exact low-confidence read the human-review gate exists to catch.
 * Structured outputs do not enforce JSON Schema `minimum`/`maximum`, so nothing upstream
 * constrains this value and this check is load-bearing rather than defence-in-depth.
 *
 * An out-of-range value means the model misunderstood the field, which is itself grounds for
 * review — so it maps to 0 (never approved) rather than to a guess about intent.
 */
function confidence01(n: number): number {
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0;
  return n;
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

  const confidence = confidence01(parsed.data.confidence);
  const rows = parsed.data.rows;
  const lowestRow = rows.reduce((min, r) => Math.min(min, confidence01(r.confidence)), 1);

  // An empty read is never "approved" — a blank result with a high score is exactly the
  // case a human needs to look at. `threshold > 0` guards against a misconfigured threshold
  // collapsing the gate: at 0 every score would pass and nothing would ever be reviewed.
  const route =
    rows.length > 0 && opts.threshold > 0 && confidence >= opts.threshold && lowestRow >= opts.threshold
      ? 'approved'
      : 'needs_review';

  return { kind: 'extracted', rows, confidence, notes: parsed.data.notes, route };
}
