import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import type { TokenVerifier } from '../src/auth/types';

/**
 * Presigned document uploads.
 *
 * This route is what made the AI extraction pipeline reachable at all: the extraction Lambda
 * triggers on `s3:ObjectCreated` under `uploads/`, and the browser has no AWS credentials and
 * must never be given any. The key shape is a contract with that Lambda
 * (docs/contracts/extraction-lambda.md) — get it wrong and the object lands somewhere the
 * trigger does not watch, so the upload silently succeeds and is never extracted.
 */

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function makeApp(withSigner = true) {
  const { db } = await createTestDb();
  const sign = vi.fn(async ({ key }: { key: string }) => ({
    url: `https://bucket.s3.amazonaws.com/${key}?X-Amz-Signature=stub`,
    expiresIn: 300,
  }));
  const app = createApp({ db, verifier, uploadSigner: withSigner ? { sign } : undefined });
  return { app, sign };
}

const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ docType: 'revenue', contentType: 'image/jpeg', filename: 'photo.jpg', ...extra });

describe('POST /api/uploads', () => {
  it('returns a presigned URL and a key the extraction trigger will see', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/uploads', { method: 'POST', headers: { ...MGR, ...JSONH }, body: body() });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { url: string; key: string; expiresIn: number };
    // uploads/<docType>/... — the prefix the Lambda parses docType from.
    expect(out.key).toMatch(/^uploads\/revenue\/[0-9a-f-]{36}-photo\.jpg$/);
    expect(out.url).toContain(out.key);
    expect(out.expiresIn).toBeGreaterThan(0);
  });

  it('routes a schedule photo under its own prefix', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/uploads', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ docType: 'schedule', filename: 'rota.png', contentType: 'image/png' }),
    });
    expect(((await res.json()) as { key: string }).key).toMatch(/^uploads\/schedule\//);
  });

  it('gives every upload a unique key, so two photos of the same sheet cannot collide', async () => {
    const { app } = await makeApp();
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/api/uploads', { method: 'POST', headers: { ...MGR, ...JSONH }, body: body() });
      keys.add(((await res.json()) as { key: string }).key);
    }
    expect(keys.size).toBe(5);
  });

  it('sanitises a filename that would escape the uploads prefix', async () => {
    // A name containing `/` or `..` would place the object outside `uploads/<docType>/`, where the
    // trigger never fires — the upload appears to work and is never extracted.
    const { app } = await makeApp();
    const res = await app.request('/api/uploads', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ filename: '../../etc/passwd' }),
    });
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(/^uploads\/revenue\/[0-9a-f-]{36}-/);
    expect(key).not.toContain('..');
    expect(key.split('/')).toHaveLength(3);
  });

  it('rejects a media type the extraction Lambda cannot read', async () => {
    // Better a 400 now than a rejected extraction job later with an opaque reason.
    const { app, sign } = await makeApp();
    const res = await app.request('/api/uploads', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ contentType: 'image/tiff' }),
    });
    expect(res.status).toBe(400);
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects an unknown docType', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/uploads', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ docType: 'invoice' }),
    });
    expect(res.status).toBe(400);
  });

  it('forbids an employee from uploading documents (403)', async () => {
    const { app, sign } = await makeApp();
    const res = await app.request('/api/uploads', { method: 'POST', headers: { ...EMP, ...JSONH }, body: body() });
    expect(res.status).toBe(403);
    expect(sign).not.toHaveBeenCalled();
  });

  it('503s rather than crashing when uploads are not configured', async () => {
    const { app } = await makeApp(false);
    const res = await app.request('/api/uploads', { method: 'POST', headers: { ...MGR, ...JSONH }, body: body() });
    expect(res.status).toBe(503);
  });

  it('passes the content type through to the signature', async () => {
    // The presigned PUT is bound to a content type; a mismatch makes the browser's upload fail
    // with an opaque 403 from S3.
    const { app, sign } = await makeApp();
    await app.request('/api/uploads', {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: body({ contentType: 'application/pdf', filename: 'scan.pdf' }),
    });
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'application/pdf' }));
  });
});
