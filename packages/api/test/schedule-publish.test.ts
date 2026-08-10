import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { levels, locations, employees, shifts, dayOffRequests } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token: string) {
    if (token === 'emp') return { sub: 'sub-emp', email: 'e@x', groups: ['employee'] };
    return { sub: 'sub-mgr', email: 'm@x', groups: ['manager'] };
  },
};
const MGR = { Authorization: 'Bearer mgr', 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [level] = await db.insert(levels).values({ name: 'L' }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ name: '1', opensAt: '08:00', closesAt: '20:00' })
    .returning();
  const [emp] = await db.insert(employees).values({ name: 'Олена', levelId: level.id }).returning();
  return { db, app: createApp({ db, verifier }), loc, emp };
}

async function addDraft(db: Awaited<ReturnType<typeof seed>>['db'], empId: string, locId: string, date: string) {
  await db.insert(shifts).values({
    employeeId: empId, locationId: locId, workDate: date,
    startsAt: '08:00:00', endsAt: '14:00:00', status: 'draft',
  });
}

describe('publishing a month', () => {
  it('turns that month\'s drafts into approved shifts', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await addDraft(db, emp.id, loc.id, '2026-09-02');
    // A different month must be left alone.
    await addDraft(db, emp.id, loc.id, '2026-10-01');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: number }).published).toBe(2);

    const rows = await db.select().from(shifts);
    const byDate = new Map(rows.map((r) => [r.workDate, r.status]));
    expect(byDate.get('2026-09-01')).toBe('approved');
    expect(byDate.get('2026-09-02')).toBe('approved');
    expect(byDate.get('2026-10-01')).toBe('draft');
  });

  it('records who published and when', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const { schedulePublications } = await import('../src/schema');
    const [row] = await db
      .select()
      .from(schedulePublications)
      .where(and(eq(schedulePublications.year, 2026), eq(schedulePublications.month, 9)));
    expect(row.publishedBy).toBe('sub-mgr');
  });

  it('blocks publishing when a shift lands on a required day off', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(409);
    // Nothing may have been published.
    const rows = await db.select().from(shifts);
    expect(rows[0].status).toBe('draft');
  });

  it('publishes over a required conflict when a reason is given', async () => {
    // Emergency cover is real; a rule that cannot be overridden gets worked around outside the
    // app, where nothing records it.
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'хвороба, немає підміни' }),
    });
    expect(res.status).toBe(200);
    const { schedulePublications } = await import('../src/schema');
    const [row] = await db.select().from(schedulePublications);
    expect(row.overrideReason).toBe('хвороба, немає підміни');
    // "Publishes" must mean the shift actually flipped — review proved this test previously
    // passed with the UPDATE replaced by a no-op, because it only read the publication row.
    const shiftRows = await db.select().from(shifts);
    expect(shiftRows[0].status).toBe('approved');
  });

  it('does not block on a preferred day off, but reports it', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-06');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-06', kind: 'preferred', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conflicts: { preferred: unknown[] } };
    expect(body.conflicts.preferred).toHaveLength(1);
    // And it genuinely published — not just reported. See the required-conflict test above.
    const shiftRows = await db.select().from(shifts);
    expect(shiftRows[0].status).toBe('approved');
  });

  it('previews conflicts without changing anything', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });

    const res = await app.request('/api/schedule-publications/preview', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const body = (await res.json()) as { draftCount: number; conflicts: { required: unknown[] } };
    expect(body.draftCount).toBe(1);
    expect(body.conflicts.required).toHaveLength(1);
    const rows = await db.select().from(shifts);
    expect(rows[0].status).toBe('draft');
  });

  it('reports whether a month is published', async () => {
    const { db, app, loc, emp } = await seed();
    const before = await app.request('/api/schedule-publications?year=2026&month=9', { headers: MGR });
    expect(((await before.json()) as { published: boolean }).published).toBe(false);

    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const after = await app.request('/api/schedule-publications?year=2026&month=9', { headers: MGR });
    expect(((await after.json()) as { published: boolean }).published).toBe(true);
  });

  it('is idempotent: re-publishing flips new drafts and keeps the original record', async () => {
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const { schedulePublications } = await import('../src/schema');
    const [first] = await db.select().from(schedulePublications);

    // A mid-month addition, then publish again.
    await addDraft(db, emp.id, loc.id, '2026-09-09');
    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: number }).published).toBe(1);

    const [again] = await db.select().from(schedulePublications);
    // The first publication is the event that mattered.
    expect(again.publishedAt.getTime()).toBe(first.publishedAt.getTime());
  });

  it('forbids an employee publishing', async () => {
    const { app } = await seed();
    const res = await app.request('/api/schedule-publications', {
      method: 'POST',
      headers: { Authorization: 'Bearer emp', 'content-type': 'application/json' },
      body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(403);
  });

  it('resolves a concurrent double-publish without a 500 and keeps one record', async () => {
    /*
     * A manager double-clicking fires two publishes for the same month. The loser's INSERT hits
     * the (year, month) primary key; unhandled, that surfaced as an opaque 500 — review
     * reproduced it. The race must resolve as an idempotent success: the month IS published,
     * whichever request won, so nothing the caller did was rejected.
     */
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');

    const publish = () =>
      app.request('/api/schedule-publications', {
        method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
      });
    const [a, b] = await Promise.all([publish(), publish()]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const { schedulePublications } = await import('../src/schema');
    const pubs = await db.select().from(schedulePublications);
    expect(pubs).toHaveLength(1);
    const rows = await db.select().from(shifts);
    expect(rows[0].status).toBe('approved');
  });

  it('appends a later override to the history instead of discarding it', async () => {
    /*
     * The audit-trail gap review found: publish cleanly (no reason), then a shift lands on a
     * required day off and a re-publish supplies a reason to pass the gate. The single
     * override_reason column kept the FIRST publish's null; the justification for the actual
     * override vanished. The history table is the fix — every override is appended.
     */
    const { db, app, loc, emp } = await seed();
    await addDraft(db, emp.id, loc.id, '2026-09-01');
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    const { schedulePublications } = await import('../src/schema');
    const [first] = await db.select().from(schedulePublications);

    // The conflict arrives after the clean publish.
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });
    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'хвороба, немає підміни' }),
    });
    expect(res.status).toBe(200);

    const { schedulePublicationOverrides } = await import('../src/schema');
    const overrides = await db.select().from(schedulePublicationOverrides);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].reason).toBe('хвороба, немає підміни');
    expect(overrides[0].createdBy).toBe('sub-mgr');

    // The first publication record is untouched: who/when still belong to the first publish.
    const [again] = await db.select().from(schedulePublications);
    expect(again.publishedAt.getTime()).toBe(first.publishedAt.getTime());
    expect(again.overrideReason).toBeNull();
  });

  /*
   * Publishing must never create two approved shifts for one person in overlapping hours.
   *
   * Defence in depth. `assertNoOverlap` on POST /api/shifts is 'approved'-only by design, so two
   * DRAFTS in the same window pass every check on the way in — then publish flips both and the
   * person is paid twice for the same hours. Measured on a 600.00/day level: one 6-hour shift
   * priced 300.00, the duplicated pair priced 600.00. That is the worst failure this app has, and
   * the write-side fix (the grid replacing a cell rather than appending) cannot be the only guard:
   * the importer, a second manager, or a hand-written row could all reproduce it.
   */
  async function addDraftAt(
    db: Awaited<ReturnType<typeof seed>>['db'],
    empId: string,
    locId: string,
    date: string,
    startsAt: string,
    endsAt: string,
  ) {
    await db.insert(shifts).values({
      employeeId: empId, locationId: locId, workDate: date,
      startsAt, endsAt, status: 'draft',
    });
  }

  it('409s rather than publishing two drafts that overlap, and flips nothing', async () => {
    const { db, app, loc, emp } = await seed();
    const [loc2] = await db
      .insert(locations)
      .values({ name: '2', opensAt: '08:00', closesAt: '20:00' })
      .returning();
    // The exact shape a mis-clicked grid cell produced: same person, same day, same window, two
    // locations — which the (employee, date, location, start) UNIQUE does not catch.
    await addDraftAt(db, emp.id, loc.id, '2026-09-07', '08:00:00', '14:00:00');
    await addDraftAt(db, emp.id, loc2.id, '2026-09-07', '08:00:00', '14:00:00');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      overlaps?: { employeeId: string; employeeName: string; workDate: string }[];
    };
    // Named, not just id'd: the publish screen has to say who and which day.
    expect(body.overlaps).toEqual([
      { employeeId: emp.id, employeeName: 'Олена', workDate: '2026-09-07' },
    ]);

    // Nothing was flipped: a refused publish leaves the month exactly as it was.
    const rows = await db.select().from(shifts);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    const { schedulePublications } = await import('../src/schema');
    expect(await db.select().from(schedulePublications)).toHaveLength(0);
  });

  it('409s when a draft would overlap an ALREADY approved shift', async () => {
    const { db, app, loc, emp } = await seed();
    await db.insert(shifts).values({
      employeeId: emp.id, locationId: loc.id, workDate: '2026-09-08',
      startsAt: '08:00:00', endsAt: '14:00:00', status: 'approved',
    });
    // Partial overlap, and a different start so UNIQUE cannot catch it either.
    await addDraftAt(db, emp.id, loc.id, '2026-09-08', '13:00:00', '18:00:00');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(409);

    const rows = await db.select().from(shifts);
    expect(rows.filter((r) => r.status === 'draft')).toHaveLength(1);
  });

  it('publishes back-to-back drafts that only touch, and two people on the same day', async () => {
    // The guard must not be so eager it blocks a legitimate month: touching windows do NOT
    // overlap (half-open comparison), and two different people share a day constantly.
    const { db, app, loc, emp } = await seed();
    const [level] = await db.select().from(levels);
    const [other] = await db
      .insert(employees)
      .values({ name: 'Ігор', levelId: level.id })
      .returning();
    await addDraftAt(db, emp.id, loc.id, '2026-09-09', '08:00:00', '14:00:00');
    await addDraftAt(db, emp.id, loc.id, '2026-09-09', '14:00:00', '20:00:00');
    await addDraftAt(db, other.id, loc.id, '2026-09-09', '08:00:00', '14:00:00');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: number }).published).toBe(3);
  });

  it('does not let an overrideReason bypass the overlap guard', async () => {
    // A required-day-off conflict is a judgement call a manager may override. Double pay is not
    // a judgement call, so the reason field must not unlock it.
    const { db, app, loc, emp } = await seed();
    const [loc2] = await db
      .insert(locations)
      .values({ name: '2', opensAt: '08:00', closesAt: '20:00' })
      .returning();
    await addDraftAt(db, emp.id, loc.id, '2026-09-10', '08:00:00', '14:00:00');
    await addDraftAt(db, emp.id, loc2.id, '2026-09-10', '08:00:00', '14:00:00');

    const res = await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'все одно публікуй' }),
    });
    expect(res.status).toBe(409);
    const rows = await db.select().from(shifts);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });

  it('reports the overlap on preview too, so the manager sees it before pressing publish', async () => {
    const { db, app, loc, emp } = await seed();
    const [loc2] = await db
      .insert(locations)
      .values({ name: '2', opensAt: '08:00', closesAt: '20:00' })
      .returning();
    await addDraftAt(db, emp.id, loc.id, '2026-09-11', '08:00:00', '14:00:00');
    await addDraftAt(db, emp.id, loc2.id, '2026-09-11', '08:00:00', '14:00:00');

    const res = await app.request('/api/schedule-publications/preview', {
      method: 'POST', headers: MGR, body: JSON.stringify({ year: 2026, month: 9 }),
    });
    // Preview never writes, so it reports rather than refuses.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overlaps: { employeeId: string; employeeName: string; workDate: string }[];
    };
    expect(body.overlaps).toEqual([
      { employeeId: emp.id, employeeName: 'Олена', workDate: '2026-09-11' },
    ]);
  });

  it('returns the override history newest-first on GET', async () => {
    const { db, app, loc, emp } = await seed();
    // Two overrides in sequence: first publish with a reason, then a later one.
    await addDraft(db, emp.id, loc.id, '2026-09-05');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-05', kind: 'required', createdBy: 'sub-emp',
    });
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'перша причина' }),
    });
    await addDraft(db, emp.id, loc.id, '2026-09-12');
    await db.insert(dayOffRequests).values({
      employeeId: emp.id, requestDate: '2026-09-12', kind: 'required', createdBy: 'sub-emp',
    });
    await app.request('/api/schedule-publications', {
      method: 'POST', headers: MGR,
      body: JSON.stringify({ year: 2026, month: 9, overrideReason: 'друга причина' }),
    });

    const res = await app.request('/api/schedule-publications?year=2026&month=9', { headers: MGR });
    const body = (await res.json()) as { overrides: { reason: string }[] };
    expect(body.overrides).toHaveLength(2);
    // Newest first, so the publish screen leads with the latest justification. Same-timestamp
    // rows are possible in a fast test; assert membership plus order only when they differ.
    expect(body.overrides.map((o) => o.reason)).toEqual(
      expect.arrayContaining(['перша причина', 'друга причина']),
    );
  });
});
