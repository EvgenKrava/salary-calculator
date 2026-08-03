import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readJson, getOr404 } from '../src/http/validation';

const schema = z.object({ name: z.string().min(1) });

function app() {
  const a = new Hono();
  a.post('/echo', async (c) => c.json(await readJson(c, schema)));
  a.get('/first', (c) => c.json(getOr404([{ id: 'x' }])));
  a.get('/none', (c) => c.json(getOr404([] as { id: string }[], 'nope')));
  a.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: 'internal' }, 500);
  });
  return a;
}

describe('readJson', () => {
  it('returns parsed data for a valid body', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ok' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'ok' });
  });

  it('rejects an invalid body with 400 and a field detail', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toMatch(/name/);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('getOr404', () => {
  it('returns the first row when present', async () => {
    const res = await app().request('/first');
    expect(await res.json()).toEqual({ id: 'x' });
  });

  it('throws 404 when empty', async () => {
    const res = await app().request('/none');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'nope' });
  });
});