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

  it('carries the parsed error body so callers can reach fields beyond the message', async () => {
    // The blocked-salary-run 409 sends { error, gaps }. The message string alone loses the
    // gaps array, and the blocked-run screen needs it to render the manager's worklist.
    const gaps = [{ employeeId: 'e1', locationId: 'l1', date: '2026-05-03' }];
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'revenue data incomplete for the period', gaps }, 409));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.post('/api/salary-runs', {})).rejects.toMatchObject({
      body: { error: 'revenue data incomplete for the period', gaps },
    });
  });

  it('leaves body undefined when the error response is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('gateway timeout', { status: 504 }));
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 't', fetchImpl: fetchMock as never });
    await expect(api.get('/x')).rejects.toMatchObject({ body: undefined });
  });
});

describe('day-off and publish endpoints', () => {
  it('builds a month-scoped day-off query', () => {
    const qs = new URLSearchParams({ year: '2026', month: '9' });
    qs.set('employeeId', 'e1');
    expect(`/api/day-off-requests?${qs}`).toBe(
      '/api/day-off-requests?year=2026&month=9&employeeId=e1',
    );
  });
});
