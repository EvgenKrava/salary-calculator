import { describe, it, expect } from 'vitest';
import { parseExtractionResponse } from '../src/parseResponse';

const OPTS = { docType: 'revenue' as const, threshold: 0.85 };

/**
 * A successful Bedrock response: the payload arrives as the already-parsed `input` of the
 * forced `record_extraction` tool call, NOT as JSON text. Bedrock rejects structured outputs
 * (see buildRequest), so this tool-call shape is the real wire format.
 */
function ok(payload: unknown, stop = 'tool_use') {
  return {
    stop_reason: stop,
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'record_extraction',
        // Round-tripped through JSON because that is what the SDK hands back: it parses the
        // wire body, so `input` can only ever contain JSON-representable values. Passing a
        // live JS object here would let NaN/Infinity reach the parser, which cannot happen
        // in production and would make the tests below assert against an impossible input.
        input: JSON.parse(JSON.stringify(payload)),
      },
    ],
  };
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

  it('reports a prose answer as unusable and keeps the prose for the reviewer', () => {
    // `tool_choice` is forced, but if the model ever answers in text instead, that text is
    // the only clue a reviewer has about why the document did not transcribe.
    const out = parseExtractionResponse(
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The photo is too blurry.' }] },
      OPTS,
    );
    expect(out).toMatchObject({ kind: 'unusable', raw: 'The photo is too blurry.' });
  });

  it('reports a response with no content at all as unusable', () => {
    const out = parseExtractionResponse({ stop_reason: 'end_turn', content: [] }, OPTS);
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  it('ignores a tool call with a different name rather than trusting its input', () => {
    // Guards the buildRequest/parseResponse name contract: reading any tool_use block would
    // let an unrelated call's arguments be validated as an extraction payload.
    const out = parseExtractionResponse(
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'something_else', input: GOOD }],
      },
      OPTS,
    );
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  it('reports a schema-violating payload as unusable', () => {
    const out = parseExtractionResponse(ok({ rows: 'not an array', confidence: 0.9 }), OPTS);
    expect(out).toMatchObject({ kind: 'unusable' });
  });

  // These assert the ROUTING consequence, not a bound on the number. An earlier version
  // asserted only `confidence <= 1`, which passed against the bug: clamping saturated an
  // out-of-range score UP to 1.0, so a percentage-style `20` scored maximum and auto-approved.
  it.each([20, 5, 100, -1])(
    'sends an out-of-contract confidence (%p) to review instead of trusting it',
    (confidence) => {
      const out = parseExtractionResponse(ok({ ...GOOD, confidence }), OPTS);
      expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
      expect((out as { confidence: number }).confidence).toBe(0);
    },
  );

  // NaN/Infinity cannot survive JSON: `JSON.stringify(NaN)` is `null` (and the SDK parses the
  // wire body, so tool input is always JSON-representable), which makes these schema
  // violations before confidence is ever read. Asserted so the safe outcome is pinned —
  // either way they must not approve.
  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a non-finite confidence (%p) as unusable, never approved',
    (confidence) => {
      const out = parseExtractionResponse(ok({ ...GOOD, confidence }), OPTS);
      expect(out).toMatchObject({ kind: 'unusable' });
    },
  );

  it('sends an out-of-contract ROW confidence to review even when the document score is high', () => {
    const out = parseExtractionResponse(
      ok({ ...GOOD, rows: [{ ...GOOD.rows[0], confidence: 20 }], confidence: 0.95 }),
      OPTS,
    );
    expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
  });

  it('never approves when the threshold is misconfigured to 0', () => {
    // Number('') === 0. If a zero threshold reached the comparison, every score would pass
    // and human review would be silently disabled for every document.
    const out = parseExtractionResponse(ok({ ...GOOD, confidence: 0.01 }), { ...OPTS, threshold: 0 });
    expect(out).toMatchObject({ kind: 'extracted', route: 'needs_review' });
  });
});
