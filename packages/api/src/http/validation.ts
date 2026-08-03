import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodSchema } from 'zod';

/** Parse and validate a JSON request body; throws HTTPException(400) on failure. */
export async function readJson<T>(c: Context, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new HTTPException(400, { message: `validation failed: ${detail}` });
  }
  return parsed.data;
}

/** Return the first row, or throw HTTPException(404) if there is none. */
export function getOr404<T>(rows: T[], message = 'not found'): T {
  if (rows.length === 0) throw new HTTPException(404, { message });
  return rows[0];
}