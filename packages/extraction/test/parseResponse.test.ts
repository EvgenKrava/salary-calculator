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

  // NaN/Infinity cannot survive JSON: `JSON.stringify(NaN)` is `null`, so these are rejected
  // as schema violations before confidence is read. Asserted so the safe outcome is pinned —
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
