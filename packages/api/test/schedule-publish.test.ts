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
  const [level] = await db.insert(levels).values({ name: 'L', ratePerDay: '600.00' }).returning();
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
});
