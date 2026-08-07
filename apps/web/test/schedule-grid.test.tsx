import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatDate, t } from '../src/lib/i18n';

/**
 * The grid is exercised through the REAL query hooks with `fetch` stubbed, not with
 * `../src/lib/queries` mocked wholesale.
 *
 * That choice is the point of this file. An earlier version of these tests mocked the queries
 * module, so `expect(assign.mutateAsync).toHaveBeenCalledWith({ status: 'draft' })` passed while
 * the app was broken two ways the mock could not see: `useAssignShift`'s body type had no `status`
 * field (a typecheck error on that exact line), and the API's assign schema rejected `'draft'` with
 * a 400. A green suite proved only that the component talked to its own mock correctly. Reading the
 * requests `fetch` actually received is what makes a wrong endpoint, param, or body shape fail.
 */

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ getToken: async () => 'tok' }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));

const { ScheduleGrid } = await import('../src/routes/ScheduleGrid');

/** This month, so the component's own `new Date()` lands inside the fixtures. */
const now = new Date();
const YEAR = now.getUTCFullYear();
const MONTH = now.getUTCMonth() + 1;
const MM = String(MONTH).padStart(2, '0');
const iso = (day: number) => `${YEAR}-${MM}-${String(day).padStart(2, '0')}`;

const EMPLOYEES = [
  { id: 'e1', name: 'Олена', levelId: 'lv1', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e2', name: 'Ігор', levelId: 'lv1', revenuePercent: 0, cognitoSub: null, active: false },
];
const LOCATIONS = [
  { id: 'l1', name: '1', opensAt: '08:00', closesAt: '20:00' },
  { id: 'l2', name: '2', opensAt: '09:00', closesAt: '21:00' },
];
const SLOTS_L1 = [
  { locationId: 'l1', slotNumber: 1, startsAt: '08:00', endsAt: '14:00' },
  { locationId: 'l1', slotNumber: 2, startsAt: '14:00', endsAt: '20:00' },
];
// Deliberately DIFFERENT windows: the grid must write each location's own hours, not the first
// location's. A slot window is a payroll input — the wrong one pays the wrong amount.
const SLOTS_L2 = [
  { locationId: 'l2', slotNumber: 1, startsAt: '09:00', endsAt: '15:00' },
  { locationId: 'l2', slotNumber: 2, startsAt: '15:00', endsAt: '21:00' },
];

interface Fixture {
  shifts?: unknown[];
  dayOff?: unknown[];
  publication?: unknown;
  slotsL1?: unknown;
  slotsL2?: unknown;
  preview?: unknown;
  onPublish?: () => Response;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Route stubbed requests by URL, so each test states only what it cares about. */
function stubFetch(fx: Fixture = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url.includes('/api/employees')) return jsonResponse(EMPLOYEES);
    if (url.includes('/api/locations/l1/slots')) return jsonResponse(fx.slotsL1 ?? SLOTS_L1);
    if (url.includes('/api/locations/l2/slots')) return jsonResponse(fx.slotsL2 ?? SLOTS_L2);
    if (url.includes('/api/locations')) return jsonResponse(LOCATIONS);
    if (url.includes('/api/day-off-requests')) return jsonResponse(fx.dayOff ?? []);
    if (url.includes('/api/schedule-publications/preview')) {
      return jsonResponse(
        fx.preview ?? { draftCount: 0, conflicts: { required: [], preferred: [] }, overlaps: [] },
      );
    }
    if (url.includes('/api/schedule-publications')) {
      if (method === 'POST') return fx.onPublish ? fx.onPublish() : jsonResponse({ published: 0, conflicts: { required: [], preferred: [] } });
      return jsonResponse(fx.publication ?? { published: false, overrides: [] });
    }
    if (url.includes('/api/shifts')) {
      if (method === 'POST') return jsonResponse({ id: 'new', status: 'draft' }, 201);
      if (method === 'DELETE') return jsonResponse({ deleted: 'ok' });
      return jsonResponse(fx.shifts ?? []);
    }
    throw new Error(`unstubbed request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function renderGrid() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ScheduleGrid />
    </QueryClientProvider>,
  );
}

/** The grid renders after its queries settle; the name column is the tell. */
async function waitForGrid() {
  await waitFor(() => expect(screen.getByText('Олена')).toBeInTheDocument());
}

const draftShift = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  employeeId: 'e1',
  locationId: 'l1',
  workDate: iso(3),
  startsAt: '08:00',
  endsAt: '14:00',
  status: 'draft',
  source: 'native',
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ScheduleGrid', () => {
  it('renders one row per active employee', async () => {
    stubFetch();
    renderGrid();
    await waitForGrid();
    // An inactive employee cannot be scheduled, so they are not a row.
    expect(screen.queryByText('Ігор')).not.toBeInTheDocument();
  });

  it('writes a draft shift with the chosen location\'s own slot window', async () => {
    const calls = stubFetch();
    renderGrid();
    await waitForGrid();

    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) }));
    await userEvent.click(await screen.findByRole('button', { name: /^2$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/shifts'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/shifts'))!;
    expect(post.body).toEqual({
      employeeId: 'e1',
      locationId: 'l2',
      workDate: iso(3),
      // Location 2's slot 1 is 09:00-15:00, NOT location 1's 08:00-14:00. Writing the first
      // location's window for every location records the wrong hours, and hours are pay.
      startsAt: '09:00',
      endsAt: '15:00',
      status: 'draft',
    });
  });

  it('sends status draft, which the API only began accepting alongside this screen', async () => {
    const calls = stubFetch();
    renderGrid();
    await waitForGrid();
    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) }));
    await userEvent.click(await screen.findByRole('button', { name: /^1$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ status: 'draft' });
  });

  it('deletes the old shift BEFORE inserting when a cell changes location', async () => {
    /*
     * A cell holds exactly one location. Appending instead of replacing is what produced two
     * approved shifts in one window after publish, and on a 600.00/day level that priced 300.00 as
     * 600.00 — the same hours paid twice. Order matters, so it is asserted.
     */
    const calls = stubFetch({ shifts: [draftShift()] });
    renderGrid();
    await waitForGrid();

    await userEvent.click(screen.getByRole('button', { name: /Олена, 3 число/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^2$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/shifts'))).toBe(true));
    const shiftCalls = calls.filter(
      (c) => c.url.includes('/api/shifts') && (c.method === 'DELETE' || c.method === 'POST'),
    );
    expect(shiftCalls[0].method).toBe('DELETE');
    expect(shiftCalls[0].url).toContain('/api/shifts/s1');
    expect(shiftCalls[1].method).toBe('POST');
    expect(shiftCalls[1].body).toMatchObject({ locationId: 'l2' });
  });

  it('does not delete anything when filling an empty cell', async () => {
    const calls = stubFetch();
    renderGrid();
    await waitForGrid();
    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 4) }));
    await userEvent.click(await screen.findByRole('button', { name: /^1$/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('removes the shift when a filled cell is cleared', async () => {
    const calls = stubFetch({ shifts: [draftShift()] });
    renderGrid();
    await waitForGrid();

    await userEvent.click(screen.getByRole('button', { name: /Олена, 3 число/ }));
    await userEvent.click(await screen.findByRole('button', { name: t.scheduleGrid.clearCell }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('/api/shifts/s1');
  });

  it('scopes the shifts and day-off queries to the displayed month', async () => {
    const calls = stubFetch();
    renderGrid();
    await waitForGrid();

    const lastDay = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
    expect(calls.some((c) => c.url.includes(`from=${iso(1)}&to=${iso(lastDay)}`))).toBe(true);
    expect(calls.some((c) => c.url.includes(`/api/day-off-requests?year=${YEAR}&month=${MONTH}`))).toBe(true);
  });

  it('marks a day-off cell with a word and a glyph, not colour alone', async () => {
    stubFetch({ dayOff: [{ employeeId: 'e1', requestDate: iso(5), kind: 'required' }] });
    renderGrid();
    await waitForGrid();

    // The mark must show on an EMPTY cell too, so the manager sees the request before assigning.
    const cell = screen.getByRole('button', {
      name: t.scheduleGrid.cellLabelDayOff('Олена', 5, t.scheduleGrid.conflictRequired),
    });
    expect(cell.className).toContain('grid__cell--required');
    // Colour is not the only carrier: the accessible name says which kind, and a glyph prints.
    expect(cell.textContent).toContain(t.scheduleGrid.markRequired);
  });

  it('names the assigned location in a filled cell\'s accessible name', async () => {
    stubFetch({ shifts: [draftShift()] });
    renderGrid();
    await waitForGrid();
    expect(
      screen.getByRole('button', { name: t.scheduleGrid.cellLabelFilled('Олена', 3, '1') }),
    ).toBeInTheDocument();
  });

  it('totals shifts per person and people per day', async () => {
    stubFetch({
      shifts: [draftShift({ id: 's1', workDate: iso(1) }), draftShift({ id: 's2', workDate: iso(2) })],
    });
    renderGrid();
    await waitForGrid();
    const row = screen.getByText('Олена').closest('tr')!;
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('keeps two slots on the same day distinct', async () => {
    // One person can legitimately work a morning at one café and an evening at another, so the
    // grid is per-slot: slot 1's cell must not show slot 2's shift.
    stubFetch({
      shifts: [draftShift({ id: 's2', workDate: iso(3), startsAt: '14:00', endsAt: '20:00' })],
    });
    renderGrid();
    await waitForGrid();

    // Slot 1 is active: the 14:00 shift belongs to slot 2, so this cell reads as empty.
    expect(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) })).toBeInTheDocument();

    // Tabs are labelled from the first location that defines the slot, so slot 2 reads 14:00-20:00.
    await userEvent.click(screen.getByRole('tab', { name: t.scheduleGrid.slotTab(2, '14:00', '20:00') }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: t.scheduleGrid.cellLabelFilled('Олена', 3, '1') }),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces a slots failure instead of claiming no slots are configured', async () => {
    /*
     * These are different facts. "No slots configured" tells the manager to ask an admin to set
     * them up; a failed request means the hours are UNKNOWN, and writing a cell anyway falls back
     * to the location's full opening hours — recording a 6-hour shift as a 12-hour day.
     */
    stubFetch({ slotsL1: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/slots')) return jsonResponse({ error: 'forbidden' }, 403);
        if (url.includes('/api/employees')) return jsonResponse(EMPLOYEES);
        if (url.includes('/api/locations')) return jsonResponse(LOCATIONS);
        if (url.includes('/api/day-off-requests')) return jsonResponse([]);
        if (url.includes('/api/schedule-publications')) return jsonResponse({ published: false, overrides: [] });
        if (url.includes('/api/shifts')) return jsonResponse([]);
        throw new Error(`unstubbed: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
    renderGrid();
    expect(await screen.findByText(t.scheduleGrid.slotsFailed)).toBeInTheDocument();
    expect(screen.queryByText(t.scheduleGrid.noSlots)).not.toBeInTheDocument();
  });

  it('closes the location popover on Escape', async () => {
    stubFetch();
    renderGrid();
    await waitForGrid();
    await userEvent.click(screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) }));
    expect(await screen.findByRole('button', { name: /^1$/ })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^1$/ })).not.toBeInTheDocument());
  });

  it('marks the open cell with aria-expanded', async () => {
    stubFetch();
    renderGrid();
    await waitForGrid();
    const cell = screen.getByRole('button', { name: t.scheduleGrid.cellLabel('Олена', 3) });
    expect(cell).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(cell);
    await waitFor(() => expect(cell).toHaveAttribute('aria-expanded', 'true'));
  });
});

describe('PublishPanel', () => {
  it('renders the overlap blocker from a refused publish', async () => {
    /*
     * The 409 the API raises when publishing would double-pay someone. It carries a structured
     * body so this panel can name the days in Ukrainian rather than showing the API's English.
     */
    stubFetch({
      // A month with drafts to publish; the overlap only surfaces when the publish is attempted.
      preview: { draftCount: 4, conflicts: { required: [], preferred: [] }, overlaps: [] },
      onPublish: () =>
        jsonResponse(
          {
            error: '1 employee-day(s) would have two overlapping shifts',
            code: 'publish_overlaps',
            overlaps: [{ employeeId: 'e1', employeeName: 'Олена', workDate: iso(7) }],
          },
          409,
        ),
    });
    renderGrid();
    await waitForGrid();

    await userEvent.click(screen.getByRole('button', { name: t.publish.button }));
    // Preview first, then the publish attempt.
    await userEvent.click(await screen.findByRole('button', { name: t.publish.button }));

    expect(await screen.findByText(t.publish.overlapsTitle(1))).toBeInTheDocument();
    expect(screen.getByText(t.publish.overlapsHint)).toBeInTheDocument();
    // The offending day is named, not just counted — scoped to the blocker, since the grid rows
    // carry the same name.
    const entry = screen.getByRole('listitem');
    expect(entry.textContent).toContain('Олена');
    expect(entry.textContent).toContain(formatDate(iso(7)));

    // The action is gone, not merely disabled-with-a-reason: an overlap cannot be overridden.
    expect(screen.queryByRole('textbox', { name: t.publish.reasonLabel })).not.toBeInTheDocument();
  });

  it('shows the override history, newest first', async () => {
    stubFetch({
      publication: {
        published: true,
        publishedAt: '2026-08-05T09:00:00.000Z',
        overrides: [
          { reason: 'друга причина', createdBy: 'mgr-2', createdAt: '2026-08-05T09:00:00.000Z' },
          { reason: 'перша причина', createdBy: 'mgr-1', createdAt: '2026-08-01T09:00:00.000Z' },
        ],
      },
    });
    renderGrid();
    await waitForGrid();

    expect(await screen.findByText(t.publish.historyTitle)).toBeInTheDocument();
    const entries = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(entries[0]).toContain('друга причина');
    expect(entries[1]).toContain('перша причина');
  });
});
