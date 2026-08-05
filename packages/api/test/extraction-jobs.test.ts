import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { createTestDb } from '../src/db/testDb';
import { extractionJobs } from '../src/schema';
import type { TokenVerifier } from '../src/auth/types';

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'mgr') return { sub: 'u-mgr', groups: ['manager'] };
    if (token === 'emp') return { sub: 'u-emp', groups: ['employee'] };
    throw new Error('bad');
  },
};
const MGR = { Authorization: 'Bearer mgr' };
const EMP = { Authorization: 'Bearer emp' };
const JSONH = { 'content-type': 'application/json' };

async function seed() {
  const { db } = await createTestDb();
  const [job] = await db
    .insert(extractionJobs)
    .values({
      docType: 'revenue',
      s3Key: 'uploads/revenue/a.jpg',
      status: 'needs_review',
      confidence: '0.400',
      extractedJson: { rows: [{ locationName: '1', amount: '1000.00' }] },
    })
    .returning();
  return { app: createApp({ db, verifier }), job };
}

describe('extraction job review', () => {
  it('forbids an employee (403)', async () => {
    const { app } = await seed();
    expect((await app.request('/api/extraction-jobs', { headers: EMP })).status).toBe(403);
  });

  it('lists jobs and filters by status', async () => {
    const { app } = await seed();
    expect((await (await app.request('/api/extraction-jobs', { headers: MGR })).json())).toHaveLength(1);
    const filtered = await app.request('/api/extraction-jobs?status=approved', { headers: MGR });
    expect(await filtered.json()).toHaveLength(0);
  });

  it('returns one job with its extracted payload', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}`, { headers: MGR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docType: string; status: string; extracted: unknown };
    expect(body).toMatchObject({ docType: 'revenue', status: 'needs_review' });
    expect(body.extracted).toBeTruthy();
  });

  it('approves a job and records who reviewed it', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}/approve`, {
      method: 'POST',
      headers: MGR,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reviewedBy: string };
    expect(body.status).toBe('approved');
    expect(body.reviewedBy).toBe('u-mgr');
  });

  it('rejects a job with a reason', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}/reject`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ reason: 'photo unreadable' }),
    });
    expect(((await res.json()) as { status: string }).status).toBe('rejected');
  });

  it('404s unknown and malformed ids', async () => {
    const { app } = await seed();
    expect((await app.request('/api/extraction-jobs/not-a-uuid', { headers: MGR })).status).toBe(404);
    expect(
      (await app.request('/api/extraction-jobs/00000000-0000-0000-0000-000000000000', { headers: MGR })).status,
    ).toBe(404);
  });
});
