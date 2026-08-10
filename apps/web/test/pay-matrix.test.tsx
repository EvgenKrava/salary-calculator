import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { t } from '../src/lib/i18n';

/**
 * The (level, location) pay matrix.
 *
 * Exercised through the REAL query hooks with `fetch` stubbed, not with `../src/lib/queries`
 * mocked wholesale — the harness from `schedule-grid.test.tsx`, for the reason recorded there:
 * a mocked hook proves the component talked to its own mock, not that the request it sent is
 * one the API accepts. That distinction is load-bearing here twice over:
 *
 * 1. The percent on the wire is a FRACTION (0.03) while the UI shows a percentage (3). A mock
 *    asserting `mutateAsync` was called with the number on screen would pass on a build that
 *    pays 3% of revenue as 300%.
 * 2. PUT /api/pay-rates takes the FULL cell, not a patch — an omitted `revenuePercent` resets
 *    the stored one to 0 (pinned by an API test). So editing the rate alone must still send
 *    the percent, and only the captured request body shows whether it did.
 */

const role = { isAdmin: true, isManager: true, isEmployee: false };

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ getToken: async () => 'tok' }),
  useRole: () => role,
}));

const { PayMatrixPanel } = await import('../src/routes/PayMatrixPanel');

const LEVELS = [
  { id: 'lv1', name: 'Бариста' },
  { id: 'lv2', name: 'Старший бариста' },
];
const LOCATIONS = [
  { id: 'loc1', name: 'Центр', opensAt: '08:00', closesAt: '20:00' },
  { id: 'loc2', name: 'Поділ', opensAt: '09:00', closesAt: '21:00' },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Fixture {
  /** Configured cells. GET returns a SPARSE list — an absent cell blocks payroll. */
  rates?: unknown[];
  /** Status for the pay-rates read, e.g. a role that may not read it. */
  ratesStatus?: number;
  /** Status for the write, so a refused PUT can be asserted on rather than assumed. */
  putStatus?: number;
}

function stubFetch(fx: Fixture = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url.includes('/api/pay-rates')) {
      if (method === 'PUT') {
        if (fx.putStatus) return jsonResponse({ error: 'refused' }, fx.putStatus);
        return jsonResponse(JSON.parse(init!.body as string));
      }
      if (method === 'DELETE') return jsonResponse({ deleted: true });
      if (fx.ratesStatus) return jsonResponse({ error: 'forbidden' }, fx.ratesStatus);
      return jsonResponse(fx.rates ?? []);
    }
    if (url.includes('/api/levels')) return jsonResponse(LEVELS);
    if (url.includes('/api/locations')) return jsonResponse(LOCATIONS);
    throw new Error(`unstubbed request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PayMatrixPanel />
    </QueryClientProvider>,
  );
}

/** The matrix renders once levels, locations and the configured cells have all settled. */
async function waitForMatrix() {
  await waitFor(() => expect(screen.getByText('Бариста')).toBeInTheDocument());
}

const rateInput = (level: string, location: string) =>
  screen.getByLabelText(t.payMatrix.rateFor(level, location));
const percentInput = (level: string, location: string) =>
  screen.getByLabelText(t.payMatrix.percentFor(level, location));

const writes = (calls: { method: string; url: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/pay-rates'));

beforeEach(() => {
  vi.restoreAllMocks();
  role.isAdmin = true;
  role.isManager = true;
});

describe('pay matrix', () => {
  it('offers a rate and a percent for every level x location combination', async () => {
    stubFetch();
    renderPanel();
    await waitForMatrix();

    // Two levels x two locations = four cells, each with both figures. A missing cell is not a
    // cosmetic gap: it blocks payroll for that combination.
    for (const level of ['Бариста', 'Старший бариста']) {
      for (const location of ['Центр', 'Поділ']) {
        expect(rateInput(level, location)).toBeInTheDocument();
        expect(percentInput(level, location)).toBeInTheDocument();
      }
    }
  });

  it('sends the percent as a FRACTION of the percentage typed', async () => {
    /*
     * The 100x error this guards, in the direction the UI makes easy: a manager types "3"
     * meaning 3% of the location's revenue. Sending 3 unconverted is rejected by the API
     * (max 1), but sending it as anything other than 0.03 pays the wrong amount silently.
     */
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Бариста', 'Центр'), '600');
    await userEvent.type(percentInput('Бариста', 'Центр'), '3');
    await userEvent.tab();

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(writes(calls)[0].body).toEqual({
      levelId: 'lv1',
      locationId: 'loc1',
      ratePerDay: 600,
      revenuePercent: 0.03,
    });
  });

  it('writes the cell the values were typed into, not the first one', async () => {
    // Rows are levels and columns are locations; a cell that writes its neighbour's ids pays
    // the wrong people the wrong amount, and nothing on screen would say so.
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Старший бариста', 'Поділ'), '900{Enter}');

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(writes(calls)[0].body).toMatchObject({ levelId: 'lv2', locationId: 'loc2', ratePerDay: 900 });
  });

  it('does not write when focus moves from the rate to the percent of the SAME cell', async () => {
    /*
     * The write that must not happen, and the reason the cell commits as a unit.
     *
     * PUT is the full cell and an omitted percent resets the stored one to 0. If tabbing from the
     * rate to the percent committed, entering a fresh cell would write {rate, 0} and then
     * {rate, percent} — reachable, but it means every cell is momentarily configured at 0%, and
     * any failure of the second write leaves it that way permanently. Committing on cell EXIT is
     * what makes one gesture one write.
     */
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Бариста', 'Центр'), '600');
    await userEvent.tab();

    // Focus is now on this cell's percent box, so nothing has been sent yet.
    expect(percentInput('Бариста', 'Центр')).toHaveFocus();
    expect(writes(calls)).toEqual([]);

    // Leaving the cell writes exactly once, with both figures.
    await userEvent.tab();
    await waitFor(() => expect(writes(calls).length).toBe(1));
    expect(writes(calls)[0].body).toEqual({
      levelId: 'lv1',
      locationId: 'loc1',
      ratePerDay: 600,
      revenuePercent: 0,
    });
  });

  it('sends BOTH values when only the rate of a configured cell is edited', async () => {
    /*
     * PUT is the full cell, not a patch: the API resets an omitted `revenuePercent` to 0. So a
     * rate correction that forgets to resend the percent silently stops paying revenue share —
     * a pay cut with no UI trace.
     */
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    await userEvent.clear(rateInput('Бариста', 'Центр'));
    await userEvent.type(rateInput('Бариста', 'Центр'), '700{Enter}');

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(writes(calls)[0].body).toEqual({
      levelId: 'lv1',
      locationId: 'loc1',
      ratePerDay: 700,
      revenuePercent: 0.05,
    });
  });

  it('sends BOTH values when only the percent of a configured cell is edited', async () => {
    // The mirror case: a percent edit that drops the rate would zero what the day itself pays.
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    await userEvent.clear(percentInput('Бариста', 'Центр'));
    await userEvent.type(percentInput('Бариста', 'Центр'), '7');
    await userEvent.tab();

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(writes(calls)[0].body).toEqual({
      levelId: 'lv1',
      locationId: 'loc1',
      ratePerDay: 600,
      revenuePercent: 0.07,
    });
  });

  it('shows a configured rate with two decimals and the percent as a percentage', async () => {
    stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    // Money formatting, per the Money component's rule: exactly 2 decimals, never abbreviated.
    expect(rateInput('Бариста', 'Центр')).toHaveValue('600.00');
    // ...and the percent is shown as the percentage a human types, not the stored fraction.
    expect(percentInput('Бариста', 'Центр')).toHaveValue('5');
  });

  it('marks an unconfigured cell in words, because it blocks payroll for that combination', async () => {
    stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    // Three of the four cells have no rate. Each says so — an empty box is indistinguishable
    // from a zero rate, and those are different facts.
    expect(screen.getAllByText(t.payMatrix.notConfigured)).toHaveLength(3);
    expect(rateInput('Старший бариста', 'Поділ')).toHaveValue('');
  });

  it('does not write anything when a cell is entered and left unchanged', async () => {
    // Tabbing across the matrix to read it must not rewrite every cell it passes through.
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    await userEvent.click(rateInput('Бариста', 'Центр'));
    await userEvent.tab();
    await userEvent.tab();

    expect(writes(calls)).toEqual([]);
  });

  it('refuses a percent with no rate rather than writing a rate of zero', async () => {
    // A day rate of 0 with a revenue share is a real, payable configuration, so it must be
    // typed deliberately — not arrived at by leaving the rate blank.
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(percentInput('Бариста', 'Центр'), '3');
    await userEvent.tab();

    expect(await screen.findByText(t.payMatrix.rateInvalid)).toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
  });

  it('names the offending figure instead of writing an out-of-range percent', async () => {
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Бариста', 'Центр'), '600');
    await userEvent.type(percentInput('Бариста', 'Центр'), '150');
    await userEvent.tab();

    expect(await screen.findByText(t.payMatrix.percentInvalid)).toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
  });

  it('confirms a successful write, because the figure on screen does not change to show it', async () => {
    /*
     * Found by rendering the panel rather than by a test: this screen commits on leaving a cell,
     * so a corrected rate produces NO visible change — the text stays whatever was typed whether
     * the write landed or not. On every other write path in the app something moves (a schedule
     * cell fills in, a row leaves edit mode), and a failure here does say so, which makes silent
     * success the one outcome an admin cannot distinguish from having done nothing at all. On a
     * figure people are paid from, "did that save?" has to be answerable without a page reload.
     */
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    expect(screen.queryByText(t.payMatrix.saved)).not.toBeInTheDocument();

    await userEvent.clear(rateInput('Бариста', 'Центр'));
    await userEvent.type(rateInput('Бариста', 'Центр'), '700{Enter}');

    await waitFor(() => expect(writes(calls).length).toBe(1));
    expect(await screen.findByText(t.payMatrix.saved)).toBeInTheDocument();
  });

  it('withdraws the saved confirmation as soon as the figure is edited again', async () => {
    // Otherwise "збережено" sits beside a figure that is no longer what was saved — worse than
    // no confirmation, because it actively asserts something false.
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Бариста', 'Центр'), '600{Enter}');
    await waitFor(() => expect(writes(calls).length).toBe(1));
    expect(await screen.findByText(t.payMatrix.saved)).toBeInTheDocument();

    await userEvent.type(rateInput('Бариста', 'Центр'), '5');
    expect(screen.queryByText(t.payMatrix.saved)).not.toBeInTheDocument();
  });

  it('surfaces a refused write instead of leaving the typed figure looking saved', async () => {
    const calls = stubFetch({ putStatus: 403 });
    renderPanel();
    await waitForMatrix();

    await userEvent.type(rateInput('Бариста', 'Центр'), '600{Enter}');

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(await screen.findByText('refused')).toBeInTheDocument();
    // The figure stays on screen with the error beside it, so the admin can retry rather than
    // having their entry silently discarded.
    expect(rateInput('Бариста', 'Центр')).toHaveValue('600');
  });
});

describe('clearing a cell', () => {
  it('asks before removing a configured cell, because it blocks payroll', async () => {
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    await userEvent.clear(rateInput('Бариста', 'Центр'));
    await userEvent.clear(percentInput('Бариста', 'Центр'));
    await userEvent.tab();

    expect(await screen.findByText(t.payMatrix.clearConfirm)).toBeInTheDocument();
    // Nothing is removed on the strength of two emptied boxes alone.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: t.payMatrix.clear }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.method === 'DELETE')!;
    // Query params, not a path segment: the cell's key is the PAIR.
    expect(del.url).toContain('levelId=lv1');
    expect(del.url).toContain('locationId=loc1');
  });

  it('restores the configured figures when the confirmation is declined', async () => {
    // Otherwise cancelling leaves two empty boxes on screen over a cell that is still
    // configured — the admin would read the matrix as blocking a run it does not block.
    const calls = stubFetch({
      rates: [{ levelId: 'lv1', locationId: 'loc1', ratePerDay: 600, revenuePercent: 0.05 }],
    });
    renderPanel();
    await waitForMatrix();

    await userEvent.clear(rateInput('Бариста', 'Центр'));
    await userEvent.clear(percentInput('Бариста', 'Центр'));
    await userEvent.tab();
    await userEvent.click(await screen.findByRole('button', { name: t.common.cancel }));

    expect(rateInput('Бариста', 'Центр')).toHaveValue('600.00');
    expect(percentInput('Бариста', 'Центр')).toHaveValue('5');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('does not ask, or write, when an already-unconfigured cell is left empty', async () => {
    const calls = stubFetch();
    renderPanel();
    await waitForMatrix();

    await userEvent.click(rateInput('Бариста', 'Центр'));
    await userEvent.tab();
    await userEvent.tab();

    expect(screen.queryByText(t.payMatrix.clearConfirm)).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' || c.method === 'PUT')).toBe(false);
  });
});

describe('who can see the matrix', () => {
  it('is absent for a manager, who may read pay rates but not set them', async () => {
    /*
     * Writes are admin-only server-side, so a manager rendered this panel would meet a 403 on
     * every cell they touched. Worse, a setup screen offering controls that cannot work reads
     * as a broken app rather than as one they lack the role for.
     */
    role.isAdmin = false;
    role.isManager = true;
    const calls = stubFetch();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PayMatrixPanel />
      </QueryClientProvider>,
    );

    // Give the queries a turn: an assertion against the first frame passes even on a build
    // that renders the whole matrix a tick later.
    await waitFor(() => expect(screen.queryByText(t.common.loading)).not.toBeInTheDocument());
    expect(screen.queryByText(t.payMatrix.title)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.payMatrix.rateFor('Бариста', 'Центр'))).not.toBeInTheDocument();
    // ...and it does not read the endpoint on their behalf either.
    expect(calls).toEqual([]);
  });
});

describe('degraded reads', () => {
  it('states that the matrix could not be read rather than showing an empty one', async () => {
    /*
     * These are different facts. An empty matrix says "no pay is configured, go set it up"; a
     * failed read means the configured pay is UNKNOWN, and every cell would show
     * "не задано" over rates that exist — inviting an admin to overwrite live pay figures.
     */
    stubFetch({ ratesStatus: 500 });
    renderPanel();

    await waitFor(() => expect(screen.queryByText(t.common.loading)).not.toBeInTheDocument());
    expect(screen.getByText(t.common.couldNotLoad(t.payMatrix.title.toLowerCase()))).toBeInTheDocument();
    expect(screen.queryByText(t.payMatrix.notConfigured)).not.toBeInTheDocument();
  });
});
