import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson } from '../http/validation';

/**
 * Presigned upload URLs for hand-written documents.
 *
 * The AI extraction pipeline was complete and unreachable: the extraction Lambda triggers on
 * `s3:ObjectCreated` under `uploads/`, the documents bucket already allowed a browser PUT via
 * CORS, and the review queue API existed — but nothing could put a file in the bucket, because
 * the browser has no AWS credentials and must never be given any.
 *
 * A presigned PUT is the right shape here rather than uploading through the API:
 * - Photos of hand-written revenue sheets are megabytes; API Gateway caps a request at 10 MB and
 *   a Lambda payload at 6 MB, and base64 inflates by a third.
 * - The upload never occupies a Lambda, so a slow phone connection costs nothing.
 * - The API stays the only thing holding credentials.
 */

/** Media the extraction Lambda can actually read (see packages/extraction/src/mediaType.ts). */
const CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

const requestSchema = z.object({
  docType: z.enum(['revenue', 'schedule']),
  contentType: z.enum(CONTENT_TYPES),
  /** Original filename, kept only so a manager can recognise their upload in the queue. */
  filename: z.string().min(1).max(200),
});

export interface UploadSigner {
  /** Presigned PUT URL plus the key the object will land under. */
  sign(input: { key: string; contentType: string }): Promise<{ url: string; expiresIn: number }>;
}

export function createUploadRoutes(signer?: UploadSigner): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  routes.post('/', async (c) => {
    if (!signer) {
      throw new HTTPException(503, { message: 'document upload is not configured on this deployment' });
    }
    const body = await readJson(c, requestSchema);

    /*
     * Key shape is a contract with the extraction Lambda: `uploads/<docType>/<uuid>-<filename>`
     * (docs/contracts/extraction-lambda.md). The handler parses docType from the prefix, so a
     * malformed key becomes a rejected job rather than an extraction.
     *
     * The filename is sanitised rather than trusted: it reaches an S3 key, and a name containing
     * `/` would silently place the object under a different prefix — including one the trigger
     * does not watch, so the upload would succeed and never be extracted.
     */
    const safeName = body.filename
      // Strip any path structure first — only the final segment can be a filename.
      .replace(/^.*[\\/]/, '')
      .replace(/[^\w.\- ]+/gu, '_')
      .replace(/\s+/g, '_')
      // Collapse runs of dots: a bare `.` is legal in a filename but `..` is a traversal
      // sequence, and keeping it means the key still reads as an escape attempt even once the
      // slashes are gone.
      .replace(/\.{2,}/g, '.')
      // A leading dot would produce `uploads/revenue/<uuid>-.hidden`.
      .replace(/^\.+/, '')
      .slice(-80) || 'document';
    const key = `uploads/${body.docType}/${crypto.randomUUID()}-${safeName}`;

    const { url, expiresIn } = await signer.sign({ key, contentType: body.contentType });
    return c.json({ url, key, expiresIn }, 201);
  });

  return routes;
}

/** Real signer. Split out so routes stay testable without AWS. */
export function createS3UploadSigner(config: { region: string; bucket: string }): UploadSigner {
  return {
    async sign({ key, contentType }) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const client = new S3Client({ region: config.region });
      // Short expiry: the URL is used immediately by the browser that asked for it. A
      // long-lived presigned PUT is a write credential for the bucket.
      const expiresIn = 300;
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
        { expiresIn },
      );
      return { url, expiresIn };
    },
  };
}
