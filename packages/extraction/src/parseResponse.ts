import { z } from 'zod';
import { EXTRACTION_TOOL } from './buildRequest';
import type { DocType } from './schemas';

/**
 * Row shapes mirroring each doc type's JSON Schema `required` list.
 *
 * These are not redundant with the outbound schema. The tool's `input_schema` constrains what
 * the model is *asked* for, but the response still has to be validated here: a row that
 * parses as `{confidence: 0.95}` with no amount and no date would otherwise be staged as
 * approved revenue data. Bedrock also rejects `strict: true` on a tool, so tool input is
 * schema-*guided*, not schema-*enforced* — this validation is the only real gate.
 * `.passthrough()` keeps unknown fields rather than stripping them, so nothing the model
 * reported is lost before a human sees it.
 */
const revenueRow = z
  .object({
    locationName: z.string(),
    date: z.string(),
    amount: z.string(),
    confidence: z.number(),
  })
  .passthrough();

const scheduleRow = z
  .object({
    employeeName: z.string(),
    date: z.string(),
    locationName: z.string(),
    confidence: z.number(),
  })
  .passthrough();

const payloadFor = (docType: DocType) =>
  z.object({
    rows: z.array(docType === 'revenue' ? revenueRow : scheduleRow),
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
  | { kind: 'unusable'; reason: string; raw?: string };

/**
 * Read a model-reported confidence, treating anything outside 0–1 as untrustworthy.
 *
 * **Do not replace this with a clamp.** Clamping saturates *upward*: a model that reports
 * confidence as a percentage (`20` meaning 20%) would become `1.0`, clear the threshold, and
 * be auto-approved — the exact low-confidence read the human-review gate exists to catch.
 * Tool input schemas do not enforce JSON Schema `minimum`/`maximum` (and Bedrock rejects
 * `strict` outright), so nothing upstream constrains this value — the check is load-bearing
 * rather than defence-in-depth.
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
    content?: { type?: string; text?: string; name?: string; input?: unknown }[];
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

  /*
   * The payload arrives as the input to the forced `record_extraction` tool call, already
   * parsed by the SDK — there is no JSON string to decode. (Bedrock does not support
   * structured outputs; see buildRequest.) `tool_choice` is forced, but a forced choice is not
   * a guarantee: a refusal or a truncated turn can still end without the block, so its absence
   * is handled rather than assumed.
   */
  const call = res?.content?.find((b) => b?.type === 'tool_use' && b?.name === EXTRACTION_TOOL);
  if (!call) {
    // Surface whatever prose the model produced instead — that text is the only clue a
    // reviewer has about why the document did not transcribe.
    const text = res?.content?.find((b) => b?.type === 'text')?.text;
    return {
      kind: 'unusable',
      reason: `response contained no ${EXTRACTION_TOOL} tool call`,
      raw: typeof text === 'string' && text.trim() !== '' ? text : undefined,
    };
  }

  // Validate against the schema for THIS doc type, not a shape that only requires a
  // confidence. A revenue row missing `amount` must never reach `approved`.
  const parsed = payloadFor(opts.docType).safeParse(call.input);
  if (!parsed.success) {
    return {
      kind: 'unusable',
      reason: `payload did not match the ${opts.docType} schema: ${parsed.error.message}`,
      raw: JSON.stringify(call.input),
    };
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
