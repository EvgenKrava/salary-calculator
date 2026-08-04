import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, locationShiftSlots, scheduleNameMap, shifts } from '../src/schema';
import { makeScheduleWorkbookBuffer } from '../../core/test/fixtures/makeScheduleFixture';
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
}

interface CommitResponse {
  period: { year: number; month: number };
  created: number;
  skipped: number;
  conflicts: string[];
  unmappedNames: string[];
  unknownLocations: number[];
  missingSlots: string[];
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
  const [level] = await db.insert(levels).values({ name: 'L', ratePerHour: '20.00' }).returning();
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
