import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * These hooks are thin — the risk is a typo'd URL, param name, or body shape that the type
 * checker cannot catch because `api.get`/`post`/`put`/`del` accept any string path and any
 * body. So every assertion here reads the actual request `fetch` received, not a re-derivation
 * of the same logic the hook already has.
 */

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ getToken: async () => 'tok' }) }));

const {
  useDayOffRequests,
  useSetDayOff,
  useClearDayOff,
  useAppSettings,
  useUpdateAppSettings,
  usePublicationState,
  usePublishPreview,
  usePublishMonth,
  usePayRates,
  useSetPayRate,
  useClearPayRate,
} = await import('../src/lib/queries');

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/** The one request `fetchMock` received, as (method, url, parsed body). */
function requestSent(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useDayOffRequests', () => {
  it('scopes the query to year, month, and employeeId when one is given', async () => {
    fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDayOffRequests({ employeeId: 'e1', year: 2026, month: 9 }), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const req = requestSent(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.test/api/day-off-requests?year=2026&month=9&employeeId=e1');
  });

  it('omits employeeId when none is given, leaving the API to default to "everyone"', async () => {
    fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDayOffRequests({ year: 2026, month: 9 }), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const req = requestSent(fetchMock);
    expect(req.url).toBe('https://api.test/api/day-off-requests?year=2026&month=9');
  });
});

describe('useSetDayOff', () => {
  it('PUTs the request date and kind for the given employee', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSetDayOff(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://api.test/api/day-off-requests');
    expect(req.body).toEqual({ employeeId: 'e1', requestDate: '2026-09-05', kind: 'preferred' });
  });

  it('sends "required" as-is rather than defaulting to preferred', async () => {
    fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSetDayOff(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ employeeId: 'e1', requestDate: '2026-09-06', kind: 'required' });
    });

    expect(requestSent(fetchMock).body).toMatchObject({ kind: 'required' });
  });
});

describe('useClearDayOff', () => {
  it('DELETEs with employeeId and date as query params', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useClearDayOff(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ employeeId: 'e1', date: '2026-09-05' });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.test/api/day-off-requests?employeeId=e1&date=2026-09-05');
    expect(req.body).toBeUndefined();
  });
});

describe('app settings', () => {
  it('useAppSettings GETs /api/settings', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ requiredDaysOffPerMonth: 2, preferredDaysOffPerMonth: 4 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAppSettings(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const req = requestSent(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.test/api/settings');
  });

  it('useUpdateAppSettings PATCHes only the fields given', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ requiredDaysOffPerMonth: 3, preferredDaysOffPerMonth: 4 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useUpdateAppSettings(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ requiredDaysOffPerMonth: 3 });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('https://api.test/api/settings');
    expect(req.body).toEqual({ requiredDaysOffPerMonth: 3 });
  });
});

describe('usePublicationState', () => {
  it('GETs the publication state scoped to year and month', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ published: false }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePublicationState({ year: 2026, month: 9 }), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const req = requestSent(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.test/api/schedule-publications?year=2026&month=9');
  });
});

describe('usePublishPreview', () => {
  it('POSTs year and month to the preview endpoint without publishing anything', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ draftCount: 3, conflicts: { required: [], preferred: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePublishPreview(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ year: 2026, month: 9 });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.test/api/schedule-publications/preview');
    expect(req.body).toEqual({ year: 2026, month: 9 });
  });
});

describe('usePublishMonth', () => {
  it('POSTs year and month with no overrideReason when none is given', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ published: 5, conflicts: { required: [], preferred: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePublishMonth(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ year: 2026, month: 9 });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.test/api/schedule-publications');
    expect(req.body).toEqual({ year: 2026, month: 9 });
  });

  it('carries the manager-entered overrideReason so a forced publish is auditable', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ published: 5, conflicts: { required: [], preferred: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePublishMonth(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ year: 2026, month: 9, overrideReason: 'covering a call-out' });
    });

    expect(requestSent(fetchMock).body).toEqual({
      year: 2026,
      month: 9,
      overrideReason: 'covering a call-out',
    });
  });
});

describe('usePayRates', () => {
  it('GETs /api/pay-rates', async () => {
    fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePayRates(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const req = requestSent(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.test/api/pay-rates');
  });
});

describe('useSetPayRate', () => {
  it('PUTs the full cell — levelId, locationId, ratePerDay, revenuePercent', async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSetPayRate(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://api.test/api/pay-rates');
    expect(req.body).toEqual({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 });
  });

  it('omits revenuePercent from the body when the caller does not pass one, leaving the API default to apply', async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSetPayRate(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600 });
    });

    const req = requestSent(fetchMock);
    expect(req.body).toEqual({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600 });
    expect(req.body).not.toHaveProperty('revenuePercent');
  });

  it('invalidates both pay-rates and salary-runs, since a changed cell changes what a future run pays', async () => {
    fetchMock = vi.fn(async () =>
      jsonResponse({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    client.setQueryData(['pay-rates'], []);
    client.setQueryData(['salary-runs'], []);
    const { result } = renderHook(() => useSetPayRate(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600 });
    });

    expect(client.getQueryState(['pay-rates'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['salary-runs'])?.isInvalidated).toBe(true);
  });
});

describe('useClearPayRate', () => {
  it('DELETEs with levelId and locationId as query params', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useClearPayRate(), { wrapper: wrapper(newClient()) });

    await act(async () => {
      await result.current.mutateAsync({ levelId: 'lv1', locationId: 'loc1' });
    });

    const req = requestSent(fetchMock);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.test/api/pay-rates?levelId=lv1&locationId=loc1');
    expect(req.body).toBeUndefined();
  });

  it('invalidates both pay-rates and salary-runs', async () => {
    fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    client.setQueryData(['pay-rates'], []);
    client.setQueryData(['salary-runs'], []);
    const { result } = renderHook(() => useClearPayRate(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ levelId: 'lv1', locationId: 'loc1' });
    });

    expect(client.getQueryState(['pay-rates'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['salary-runs'])?.isInvalidated).toBe(true);
  });
});
