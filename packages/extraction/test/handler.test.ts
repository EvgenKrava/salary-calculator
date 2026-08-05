import { describe, it, expect, vi } from 'vitest';
import { createHandler, readThreshold, type HandlerDeps } from '../src/handler';

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
    // The row must be schema-valid for a *revenue* document, so this exercises the routing
    // decision rather than tripping doc-type validation first.
    const d = deps({
      invokeModel: vi.fn(async () => ({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rows: [{ locationName: '1', date: '2026-05-05', amount: '1234.50', confidence: 0.2 }],
              confidence: 0.2,
              notes: 'blurry',
            }),
          },
        ],
      })),
    });
    await createHandler(d)(s3Event('uploads/revenue/x.jpg'));
    expect(d.recordJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs_review', notes: 'blurry' }),
    );
  });

  it('rejects a revenue row missing required fields instead of staging it as approved', async () => {
    // Guards I2: a row that is only `{confidence: 0.95}` — no amount, no date — was staged
    // `approved`, because the payload check required nothing but a confidence number.
    const d = deps({
      invokeModel: vi.fn(async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ rows: [{ confidence: 0.95 }], confidence: 0.95, notes: '' }) }],
      })),
    });
    await createHandler(d)(s3Event('uploads/revenue/x.jpg'));
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(d.recordJob).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
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

describe('readThreshold', () => {
  // An empty CONFIDENCE_THRESHOLD used to yield Number('') === 0, which approved every
  // extraction and disabled human review with no error and no log line.
  it('falls back to the default for an unset or empty value', () => {
    expect(readThreshold({} as NodeJS.ProcessEnv)).toBe(0.85);
    expect(readThreshold({ CONFIDENCE_THRESHOLD: '' } as NodeJS.ProcessEnv)).toBe(0.85);
    expect(readThreshold({ CONFIDENCE_THRESHOLD: '   ' } as NodeJS.ProcessEnv)).toBe(0.85);
  });

  it('accepts a valid threshold', () => {
    expect(readThreshold({ CONFIDENCE_THRESHOLD: '0.9' } as NodeJS.ProcessEnv)).toBe(0.9);
    expect(readThreshold({ CONFIDENCE_THRESHOLD: '1' } as NodeJS.ProcessEnv)).toBe(1);
  });

  it('throws rather than silently disabling review on a bad value', () => {
    for (const bad of ['0', '-0.5', '1.5', 'high', 'null']) {
      expect(() => readThreshold({ CONFIDENCE_THRESHOLD: bad } as NodeJS.ProcessEnv)).toThrow(
        /CONFIDENCE_THRESHOLD/,
      );
    }
  });
});

/**
 * The one-row-per-document invariant, tested at its failure boundaries.
 *
 * These all previously broke it: recordJob sat inside the try (so a post-commit failure
 * recorded a SECOND row), the catch's recordJob was unguarded (so a DB outage aborted the
 * whole invocation and starved the remaining records), and the key decode plus the
 * unknown-prefix branch sat outside the try entirely.
 */
describe('extraction handler — one row per document', () => {
  function multiEvent(...keys: string[]) {
    return { Records: keys.map((key) => ({ s3: { bucket: { name: 'docs' }, object: { key } } })) } as never;
  }

  it('records at most one row when recordJob throws after committing', async () => {
    const recordJob = vi.fn(async () => {
      throw new Error('Data API timeout after INSERT committed');
    });
    const d = deps({ recordJob });
    await expect(createHandler(d)(s3Event('uploads/revenue/x.jpg'))).resolves.toBeUndefined();
    // Exactly one attempt: the catch must not record a second, contradictory row.
    expect(recordJob).toHaveBeenCalledTimes(1);
  });

  it('still processes later records when an earlier record fails to record', async () => {
    let call = 0;
    const recordJob = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('transient DB failure');
      return 'job-2';
    });
    const d = deps({ recordJob });
    await createHandler(d)(multiEvent('uploads/revenue/a.jpg', 'uploads/revenue/b.jpg'));
    // Record 2 must not be starved by record 1's failure.
    expect(recordJob).toHaveBeenCalledTimes(2);
    expect(recordJob).toHaveBeenLastCalledWith(expect.objectContaining({ s3Key: 'uploads/revenue/b.jpg' }));
  });

  it('does not throw or skip the batch on a malformed percent-sequence in the key', async () => {
    const d = deps();
    // '%E0%A4%A' is an invalid sequence — decodeURIComponent throws URIError on it.
    await expect(
      createHandler(d)(multiEvent('uploads/revenue/%E0%A4%A.jpg', 'uploads/revenue/good.jpg')),
    ).resolves.toBeUndefined();
    expect(d.recordJob).toHaveBeenCalledTimes(2);
    expect(d.recordJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ s3Key: 'uploads/revenue/good.jpg', status: 'approved' }),
    );
  });

  it('records one row per record for a multi-record batch', async () => {
    const d = deps();
    await createHandler(d)(multiEvent('uploads/revenue/a.jpg', 'uploads/schedule/b.png', 'bad/c.jpg'));
    expect(d.recordJob).toHaveBeenCalledTimes(3);
  });

  it('records the raw response when the payload is unusable, so a reviewer can see it', async () => {
    const d = deps({
      invokeModel: vi.fn(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }] })),
    });
    await createHandler(d)(s3Event('uploads/revenue/x.jpg'));
    expect(d.recordJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', raw: 'not json at all' }),
    );
  });
});
