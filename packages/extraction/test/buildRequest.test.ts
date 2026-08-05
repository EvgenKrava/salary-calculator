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
