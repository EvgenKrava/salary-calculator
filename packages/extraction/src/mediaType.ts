/**
 * Resolve a usable media type for an uploaded document.
 *
 * S3 does not sniff content types. A presigned `PUT` that omits `Content-Type` stores the
 * object as `binary/octet-stream` (or nothing at all), which is the common case for
 * browser/mobile uploads. Trusting `res.ContentType` alone therefore rejects perfectly good
 * photos as "unsupported media type" before the model ever sees them — the manager uploads a
 * valid JPEG and gets a rejected queue entry with a misleading reason.
 *
 * Order: trust a specific declared type, else sniff magic bytes (authoritative — it is the
 * actual file content), else fall back to the key's extension.
 */

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

/** Content types that carry no information and must not be trusted. */
function isGeneric(contentType: string): boolean {
  const t = contentType.trim().toLowerCase();
  return t === '' || t.endsWith('/octet-stream') || t === 'application/binary';
}

/** Identify a format from its leading bytes. Cheap and unambiguous for these five formats. */
export function sniffMediaType(body: Buffer): string | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (body.length >= 6 && (body.subarray(0, 6).toString('latin1') === 'GIF87a' || body.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('latin1') === 'RIFF' &&
    body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (body.length >= 4 && body.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Media type from a filename/key extension. Least reliable — a rename fools it. */
export function mediaTypeFromKey(key: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1]?.toLowerCase();
  return ext ? (BY_EXTENSION[ext] ?? null) : null;
}

/**
 * Best available media type. Returns the declared type unchanged when it is specific, so a
 * genuinely unsupported type (e.g. `image/tiff`) still reaches the caller's allowlist check
 * and is rejected with an accurate message rather than being silently re-sniffed.
 */
export function resolveMediaType(contentType: string, key: string, body: Buffer): string {
  if (!isGeneric(contentType)) return contentType;
  // Magic bytes beat the extension: the bytes are what Bedrock will actually decode.
  const sniffed = sniffMediaType(body);
  if (sniffed && SUPPORTED.has(sniffed)) return sniffed;
  const byExt = mediaTypeFromKey(key);
  if (byExt && SUPPORTED.has(byExt)) return byExt;
  return contentType;
}
