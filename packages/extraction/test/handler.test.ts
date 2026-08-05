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
