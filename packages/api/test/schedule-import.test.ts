import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, locationShiftSlots, scheduleNameMap, shifts } from '../src/schema';
import { makeScheduleWorkbookBuffer } from '../../core/test/fixtures/makeScheduleFixture';
import { makeTwoYearScheduleWorkbookBuffer } from '../../core/test/fixtures/makeTwoYearScheduleFixture';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };

interface PreviewResponse {
  months: { year: number; month: number }[];
  sourceNames: string[];
  anomalies: unknown[];
  resolved: unknown[];
  unmappedNames: string[];
  unknownLocations: number[];
  missingSlots: string[];
  inactiveEmployees: string[];
}

interface CommitResponse {
  period: { year: number; month: number };
  created: number;
  skipped: number;
  conflicts: string[];
  windowChanged: string[];
  unmappedNames: string[];
  unknownLocations: number[];
  missingSlots: string[];
  inactiveEmployees: string[];
}

/** Build the multipart body the endpoints expect. */
async function form(fields: Record<string, string>): Promise<FormData> {
  const fd = new FormData();
  const buf = await makeScheduleWorkbookBuffer();
  fd.set(
    'file',
    new File([new Uint8Array(buf)], 'schedule.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Location "1" and "2" plus slot windows and a name mapping for Олег. */
async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L' }).returning();
  const [loc1] = await db.insert(locations).values({ name: '1', opensAt: '08:00', closesAt: '20:00' }).returning();
  const [loc2] = await db.insert(locations).values({ name: '2', opensAt: '08:00', closesAt: '20:00' }).returning();
  const [oleg] = await db.insert(employees).values({ name: 'Oleg', levelId: level.id }).returning();
  for (const loc of [loc1, loc2]) {
    await db.insert(locationShiftSlots).values([
      { locationId: loc.id, slotNumber: 1, startsAt: '08:00', endsAt: '14:00' },
      { locationId: loc.id, slotNumber: 2, startsAt: '14:00', endsAt: '20:00' },
    ]);
  }
  await db.insert(scheduleNameMap).values({ sourceName: 'Олег', employeeId: oleg.id });
  return { db, app: createApp({ db, verifier }), loc1, loc2, oleg };
}

describe('schedule import', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer emp' },
      body: await form({ year: '2026' }),
    });
    expect(res.status).toBe(403);
  });

  it('previews without writing anything', async () => {
    const { db, app } = await seed();
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewResponse;
    expect(body.months).toEqual(expect.arrayContaining([{ year: 2026, month: 5 }]));
    // Олег is mapped; Марта/Тарас/Бариста 1 are not.
    expect(body.unmappedNames).toEqual(expect.arrayContaining(['Марта', 'Тарас', 'Бариста 1']));
    expect(body.resolved.length).toBeGreaterThan(0);
    expect(body.anomalies.length).toBeGreaterThan(0);
    // Nothing persisted.
    expect(await db.select().from(shifts)).toHaveLength(0);
  });

  it('reports a location number with no matching location', async () => {
    const { app } = await seed(); // fixture references location 3 in slot 2; only 1 and 2 exist
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    const body = (await res.json()) as PreviewResponse;
    expect(body.unknownLocations).toEqual(expect.arrayContaining([3]));
  });

  it('commits only the requested month as imported approved shifts', async () => {
    const { db, app, oleg } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitResponse;
    expect(body.created).toBeGreaterThan(0);

    const rows = await db.select().from(shifts);
    expect(rows.length).toBe(body.created);
    for (const row of rows) {
      expect(row.source).toBe('imported');
      expect(row.status).toBe('approved');
      expect(row.employeeId).toBe(oleg.id); // only Олег is mapped
      expect(row.workDate.startsWith('2026-05')).toBe(true); // June not committed
    }
    // Slot 1 window came from location_shift_slots.
    expect(rows[0].startsAt.slice(0, 5)).toBe('08:00');
  });

  it('is idempotent: re-committing skips existing shifts', async () => {
    const { app } = await seed();
    const first = (await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json()) as CommitResponse;
    const second = (await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json()) as CommitResponse;
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(first.created);
  });

  it('does not write an imported shift that overlaps an existing approved shift', async () => {
    const { db, app, loc2, oleg } = await seed();
    // Олег already works 09:00-15:00 at another location on a day the sheet schedules him.
    await db.insert(shifts).values({
      employeeId: oleg.id,
      locationId: loc2.id,
      workDate: '2026-05-01',
      startsAt: '09:00',
      endsAt: '15:00',
      status: 'approved',
      source: 'native',
    });

    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitResponse;
    expect(body.conflicts.length).toBeGreaterThan(0);

    // The overlapping day was not written; the pre-existing shift is untouched.
    const onDay = await db.select().from(shifts).where(eq(shifts.workDate, '2026-05-01'));
    expect(onDay).toHaveLength(1);
    expect(onDay[0].source).toBe('native');
  });

  it('reports an inactive employee mapping in inactiveEmployees and writes no shift for them (FIX 4)', async () => {
    const { db, app } = await seed();
    // Марта is unmapped by default in seed(); map her to a deactivated employee instead.
    const [level] = await db.select().from(levels);
    const [departed] = await db
      .insert(employees)
      .values({ name: 'Departed', levelId: level.id, active: false })
      .returning();
    await db.insert(scheduleNameMap).values({ sourceName: 'Марта', employeeId: departed.id });

    const preview = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    const previewBody = (await preview.json()) as PreviewResponse;
    expect(previewBody.inactiveEmployees).toEqual(expect.arrayContaining(['Марта']));
    expect(previewBody.unmappedNames).not.toContain('Марта');

    const commit = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    const commitBody = (await commit.json()) as CommitResponse;
    expect(commitBody.inactiveEmployees).toEqual(expect.arrayContaining(['Марта']));

    const rows = await db.select().from(shifts).where(eq(shifts.employeeId, departed.id));
    expect(rows).toHaveLength(0);
  });

  it('still reports an unknown location for an inactive-employee cell instead of suppressing it (FIX F)', async () => {
    const { db, app } = await seed();
    // Тарас is scheduled at location "3" in the fixture, which does not exist in seed()
    // (only "1" and "2" do). Map him to a deactivated employee so the cell is BOTH
    // inactive-employee AND unknown-location — the ordering bug this fix addresses.
    const [level] = await db.select().from(levels);
    const [departed] = await db
      .insert(employees)
      .values({ name: 'Departed Taras', levelId: level.id, active: false })
      .returning();
    await db.insert(scheduleNameMap).values({ sourceName: 'Тарас', employeeId: departed.id });

    const preview = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    const previewBody = (await preview.json()) as PreviewResponse;
    expect(previewBody.inactiveEmployees).toEqual(expect.arrayContaining(['Тарас']));
    // Before FIX F, the inactive-employee `continue` ran first and this would be empty.
    expect(previewBody.unknownLocations).toEqual(expect.arrayContaining([3]));
  });

  it('reports a narrowed slot window as windowChanged instead of silently skipping (FIX 5)', async () => {
    const { db, app, loc1 } = await seed();
    const first = (await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json()) as CommitResponse;
    expect(first.created).toBeGreaterThan(0);
    expect(first.windowChanged).toHaveLength(0);

    // An admin narrows location 1's slot-1 window (startsAt unchanged, endsAt earlier) after
    // the first commit — the exact scenario the idempotency probe used to miss because it
    // only compared startsAt.
    await db
      .update(locationShiftSlots)
      .set({ endsAt: '12:00' })
      .where(and(eq(locationShiftSlots.locationId, loc1.id), eq(locationShiftSlots.slotNumber, 1)));

    const second = (await (
      await app.request('/api/schedule-imports/commit', {
        method: 'POST',
        headers: MGR,
        body: await form({ year: '2026', month: '5' }),
      })
    ).json()) as CommitResponse;
    expect(second.created).toBe(0);
    expect(second.windowChanged.length).toBeGreaterThan(0);

    // The stale row was NOT silently folded into `skipped`, and its old (longer) window is
    // untouched rather than being overpaid on a phantom rewrite.
    const untouched = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.locationId, loc1.id), eq(shifts.startsAt, '08:00')));
    expect(untouched.length).toBeGreaterThan(0);
    for (const row of untouched) expect(row.endsAt.slice(0, 5)).toBe('14:00');
  });

  it('reports missingSlots when a (location, slot) has no configured window', async () => {
    const { db, app } = await seed();
    // The fixture schedules "Тарас" at location 3, slot 2. Create location "3" (so it is no
    // longer unknown) but do not configure its slot-2 window, and map Тарас to a real
    // employee so the cell reaches the slot check.
    const [level] = await db.select().from(levels);
    const [taras] = await db.insert(employees).values({ name: 'Taras', levelId: level.id }).returning();
    await db.insert(locations).values({ name: '3', opensAt: '08:00', closesAt: '20:00' });
    await db.insert(scheduleNameMap).values({ sourceName: 'Тарас', employeeId: taras.id });

    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    const body = (await res.json()) as PreviewResponse;
    expect(body.missingSlots).toEqual(expect.arrayContaining(['3:2']));
    expect(body.unknownLocations).not.toEqual(expect.arrayContaining([3]));
  });

  it('skips an ignored mapping silently: no shift, and not reported as unmapped', async () => {
    const { db, app } = await seed();
    // "Бариста 1" is a placeholder row in the fixture; mark it ignored rather than mapped.
    await db.insert(scheduleNameMap).values({ sourceName: 'Бариста 1', ignored: true });

    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026' }),
    });
    const body = (await res.json()) as PreviewResponse;
    expect(body.unmappedNames).not.toContain('Бариста 1');
    // Still unresolved for real people.
    expect(body.unmappedNames).toEqual(expect.arrayContaining(['Марта', 'Тарас']));

    const commit = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: '2026', month: '5' }),
    });
    const commitBody = (await commit.json()) as CommitResponse;
    expect(commitBody.unmappedNames).not.toContain('Бариста 1');
  });

  it('400s a missing file or invalid year', async () => {
    const { app } = await seed();
    const noFile = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: (() => {
        const fd = new FormData();
        fd.set('year', '2026');
        return fd;
      })(),
    });
    expect(noFile.status).toBe(400);
    const badYear = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await form({ year: 'nope' }),
    });
    expect(badYear.status).toBe(400);
  });
});

/**
 * A workbook whose timeline crosses a calendar year.
 *
 * The real client file runs Травень 2026 → Серпень 2027 as one continuous sheet. Two bugs met
 * there: the parser dated every month in the base year, and the commit route selected cells by
 * month alone — so committing one month pulled in the same month from BOTH years, and the same
 * person on the same day-of-month in two different years was reported to the manager as an
 * overlapping-shift conflict. That is the error the real file produced.
 */
describe('schedule import: workbook spanning two calendar years', () => {
  async function twoYearForm(fields: Record<string, string>): Promise<FormData> {
    const fd = new FormData();
    const buf = await makeTwoYearScheduleWorkbookBuffer();
    fd.set(
      'file',
      new File([new Uint8Array(buf)], 'two-year.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it('previews both years, so the manager can tell January 2027 from January 2026', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-imports/preview', {
      method: 'POST',
      headers: MGR,
      body: await twoYearForm({ year: '2026' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewResponse;
    expect(body.months).toEqual(
      expect.arrayContaining([
        { year: 2026, month: 12 },
        { year: 2027, month: 1 },
      ]),
    );
  });

  it('commits only the requested YEAR and month, not the same month in both years', async () => {
    const { db, app } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      // targetYear 2026 + month 12 → 1 December 2026 only.
      body: await twoYearForm({ year: '2026', targetYear: '2026', month: '12' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitResponse;

    const rows = await db.select().from(shifts);
    expect(rows).toHaveLength(1);
    expect(rows[0].workDate).toBe('2026-12-01');
    // The January row is a different period and must NOT have been treated as a conflict.
    expect(body.conflicts).toEqual([]);
  });

  it('can commit the month that falls in the FOLLOWING year', async () => {
    // The whole point of `targetYear`: with a month-only filter, or with targetYear pinned to the
    // parser's base year, January 2027 would be unreachable.
    const { db, app } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await twoYearForm({ year: '2026', targetYear: '2027', month: '1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitResponse;
    expect(body.period).toEqual({ year: 2027, month: 1 });

    const rows = await db.select().from(shifts);
    expect(rows).toHaveLength(1);
    expect(rows[0].workDate).toBe('2027-01-01');
  });

  it('defaults targetYear to year, so a single-year caller is unaffected', async () => {
    const { db, app } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await twoYearForm({ year: '2026', month: '12' }), // no targetYear
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(shifts);
    expect(rows).toHaveLength(1);
    expect(rows[0].workDate).toBe('2026-12-01');
  });

  it('rejects a nonsense targetYear rather than importing nothing silently', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-imports/commit', {
      method: 'POST',
      headers: MGR,
      body: await twoYearForm({ year: '2026', targetYear: 'notayear', month: '12' }),
    });
    expect(res.status).toBe(400);
  });
});
