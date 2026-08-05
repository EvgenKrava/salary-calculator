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
