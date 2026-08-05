export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The full parsed JSON error body, when the response was JSON — carries fields beyond
    // `error`, e.g. the blocked-salary-run 409's `gaps`, which the blocked-run screen needs
    // to render the manager's worklist rather than just the message.
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/**
 * Thin typed wrapper over fetch.
 *
 * Its one job beyond attaching the token is to turn the API's `{ error: "..." }` shape into
 * a thrown `ApiError` carrying that message — the API takes care to send useful messages
 * (409 "a shift already exists for that day", 409 "overlaps an existing approved shift"),
 * and showing the user "Request failed" instead would waste them.
 */
export function createApiClient({ baseUrl, getToken, fetchImpl = fetch }: ApiClientOptions) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let body: unknown;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed?.error) message = parsed.error;
        body = parsed;
      } catch {
        // Not JSON (a gateway error page, say) — keep the status line, no body.
      }
      throw new ApiError(message, res.status, body);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
