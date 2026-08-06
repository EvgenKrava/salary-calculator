import { describe, it, expect } from 'vitest';
import { buildExtractionRequest, EXTRACTION_TOOL } from '../src/buildRequest';

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
    expect(JSON.stringify(req)).not.toContain('budget_tokens');
  });

  /*
   * These three are the regression that shipped. The request previously carried
   * `output_config.format`, and this suite asserted that exact shape — so it was green
   * against a request Bedrock rejects on EVERY invocation:
   *
   *   400 invalid_request_error: output_config.format: Extra inputs are not permitted
   *
   * Verified against the live endpoint: Bedrock's Mantle endpoint implements none of the three
   * structured-output mechanisms, though all three work on the first-party Claude API. Passing
   * tests proved nothing here because nothing in the suite ever spoke to Bedrock.
   */
  it.each([
    ['output_config.format', (r: Record<string, unknown>) => (r.output_config as Record<string, unknown>)?.format],
    ['top-level output_format', (r: Record<string, unknown>) => r.output_format],
  ])('does not send %s — Bedrock rejects it with a 400', (_label, pick) => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE }) as Record<string, unknown>;
    expect(pick(req)).toBeUndefined();
  });

  it('does not mark the tool strict — Bedrock rejects tools.0.custom.strict with a 400', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    for (const tool of req.tools) expect(tool).not.toHaveProperty('strict');
  });

  it('carries the schema as a forced tool call, which Bedrock does support', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    expect(req.tool_choice).toEqual({ type: 'tool', name: EXTRACTION_TOOL });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0].name).toBe(EXTRACTION_TOOL);
    expect(req.tools[0].input_schema).toMatchObject({ type: 'object' });
  });

  it('keeps output_config for effort, which Bedrock does accept', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    expect(req.output_config.effort).toBe('high');
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
    expect(revenue.tools[0].input_schema).not.toEqual(schedule.tools[0].input_schema);
  });

  it('asks for a confidence signal and forbids guessing', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: IMAGE });
    const schema = req.tools[0].input_schema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('confidence');
    const prompt = JSON.stringify(req.messages);
    expect(prompt.toLowerCase()).toMatch(/do not guess|never guess/);
  });

  it('tells the model to exclude summary rows', () => {
    // A real sheet's "РАЗОМ" (total) line came back as a fourth location. Left in, that
    // double-counts the day once approved extractions commit into daily_revenue.
    const prompt = JSON.stringify(buildExtractionRequest({ docType: 'revenue', media: IMAGE }).messages);
    expect(prompt.toLowerCase()).toMatch(/total|subtotal|summary/);
  });
});

describe('request size guard', () => {
  it('rejects an oversized document with an actionable message, not an opaque 400', () => {
    // 32 MB is the API's request cap; without this check the manager sees "api error 400".
    const tooBig = 'A'.repeat(32 * 1_048_576);
    expect(() =>
      buildExtractionRequest({ docType: 'revenue', media: { mediaType: 'image/jpeg', base64: tooBig } }),
    ).toThrow(/too large/i);
  });

  it('accepts a document just under the limit', () => {
    const ok = 'A'.repeat(1_048_576);
    expect(() =>
      buildExtractionRequest({ docType: 'revenue', media: { mediaType: 'image/jpeg', base64: ok } }),
    ).not.toThrow();
  });
});

describe('model id', () => {
  it('defaults to the pinned Bedrock model id', () => {
    const req = buildExtractionRequest({ docType: 'revenue', media: { mediaType: 'image/jpeg', base64: 'AAA' } });
    expect(req.model).toBe('anthropic.claude-opus-5');
  });

  it('honours an override, so BEDROCK_MODEL_ID actually takes effect', () => {
    // Terraform sets this env var; the code used to hardcode the constant and ignore it, so
    // changing the variable looked like a deploy but changed nothing.
    const req = buildExtractionRequest({
      docType: 'revenue',
      media: { mediaType: 'image/jpeg', base64: 'AAA' },
      modelId: 'anthropic.claude-sonnet-5',
    });
    expect(req.model).toBe('anthropic.claude-sonnet-5');
  });

  it('falls back to the default for a blank override rather than sending an empty model', () => {
    for (const blank of ['', '   ']) {
      const req = buildExtractionRequest({
        docType: 'revenue',
        media: { mediaType: 'image/jpeg', base64: 'AAA' },
        modelId: blank,
      });
      expect(req.model).toBe('anthropic.claude-opus-5');
    }
  });
});
