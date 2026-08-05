import { describe, it, expect, vi } from 'vitest';
import { resolveMediaType, sniffMediaType, mediaTypeFromKey } from '../src/mediaType';
import { createHandler, type HandlerDeps } from '../src/handler';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n...');

describe('resolveMediaType', () => {
  it('sniffs a JPEG that S3 stored as binary/octet-stream', () => {
    // The day-one case: a presigned PUT without Content-Type. Previously rejected unseen.
    expect(resolveMediaType('binary/octet-stream', 'uploads/revenue/x.jpg', JPEG)).toBe('image/jpeg');
    expect(resolveMediaType('application/octet-stream', 'uploads/revenue/x', JPEG)).toBe('image/jpeg');
    expect(resolveMediaType('', 'uploads/revenue/x', PNG)).toBe('image/png');
    expect(resolveMediaType('', 'uploads/revenue/scan', PDF)).toBe('application/pdf');
  });

  it('trusts a specific declared type over sniffing', () => {
    expect(resolveMediaType('image/png', 'uploads/revenue/x.png', PNG)).toBe('image/png');
  });

  it('preserves a genuinely unsupported declared type so it is rejected accurately', () => {
    // Must NOT be silently re-sniffed into something supported — the rejection message
    // should still name the real type.
    expect(resolveMediaType('image/tiff', 'uploads/revenue/x.tiff', Buffer.from('II*\0'))).toBe('image/tiff');
  });

  it('falls back to the key extension when bytes are unrecognizable', () => {
    expect(resolveMediaType('', 'uploads/revenue/x.pdf', Buffer.from('garbage'))).toBe('application/pdf');
  });

  it('returns the generic type when nothing resolves, rather than guessing', () => {
    expect(resolveMediaType('binary/octet-stream', 'uploads/revenue/x.bin', Buffer.from('??'))).toBe('binary/octet-stream');
  });

  it('sniffs each supported format and rejects unknown bytes', () => {
    expect(sniffMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(PDF)).toBe('application/pdf');
    expect(sniffMediaType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffMediaType(Buffer.from('nope'))).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });

  it('maps extensions case-insensitively', () => {
    expect(mediaTypeFromKey('a/b/C.JPG')).toBe('image/jpeg');
    expect(mediaTypeFromKey('a/b/c')).toBeNull();
  });
});

describe('handler media-type resolution', () => {
  function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
    return {
      getObject: vi.fn(async () => ({ body: JPEG, contentType: 'binary/octet-stream' })),
      invokeModel: vi.fn(async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          rows: [{ locationName: '1', date: '2026-05-05', amount: '10.00', confidence: 0.95 }],
          confidence: 0.95, notes: '' }) }],
      })),
      recordJob: vi.fn(async () => 'job-1'),
      threshold: 0.85,
      ...overrides,
    };
  }
  const event = (key: string) => ({ Records: [{ s3: { bucket: { name: 'docs' }, object: { key } } }] }) as never;

  it('extracts a real JPEG that S3 typed as binary/octet-stream', async () => {
    const d = deps();
    await createHandler(d)(event('uploads/revenue/photo.jpg'));
    expect(d.invokeModel).toHaveBeenCalled();
    expect(d.recordJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('still rejects a genuinely unsupported type with an accurate message', async () => {
    const d = deps({ getObject: vi.fn(async () => ({ body: Buffer.from('II*\0'), contentType: 'image/tiff' })) });
    await createHandler(d)(event('uploads/revenue/x.tiff'));
    expect(d.invokeModel).not.toHaveBeenCalled();
    expect(d.recordJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', error: expect.stringContaining('image/tiff') }),
    );
  });
});
