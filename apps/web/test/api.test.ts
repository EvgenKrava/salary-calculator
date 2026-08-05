import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiClient, ApiError } from '../src/lib/api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('attaches the bearer token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 'tok', fetchImpl: fetchMock as never });
    await api.get('/api/levels');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('surfaces the API error message rather than a generic failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'level name already exists' }, 409));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.post('/api/levels', {})).rejects.toThrow(/level name already exists/);
  });

  it('exposes the status code on the error so callers can branch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'nope' }, 403));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.get('/x')).rejects.toMatchObject({ status: 403 });
  });

  it('does not crash when an error body is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('gateway timeout', { status: 504 }));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('sends no body and no content-type on GET', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await api.get('/x');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('returns undefined for a 204 rather than trying to parse it', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.del('/x')).resolves.toBeUndefined();
  });
});
