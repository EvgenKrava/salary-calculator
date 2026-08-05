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

  it('rejects a job, recording the reason, the reviewer, and the original rows', async () => {
    const { app, job } = await seed();
    const res = await app.request(`/api/extraction-jobs/${job.id}/reject`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ reason: 'photo unreadable' }),
    });
    const body = (await res.json()) as {
      status: string;
      reviewedBy: string;
      extracted: { rejectionReason?: string; rows?: unknown[] };
    };
    expect(body.status).toBe('rejected');
    // Asserting only the status let three required behaviours regress silently: WHO decided,
    // WHY, and that the extracted rows survived the payload merge.
    expect(body.reviewedBy).toBe('u-mgr');
    expect(body.extracted.rejectionReason).toBe('photo unreadable');
    expect(body.extracted.rows).toHaveLength(1);
  });

  it('forbids an employee from approving or rejecting (403)', async () => {
    const { app, job } = await seed();
    const approve = await app.request(`/api/extraction-jobs/${job.id}/approve`, {
      method: 'POST',
      headers: EMP,
    });
    expect(approve.status).toBe(403);
    const reject = await app.request(`/api/extraction-jobs/${job.id}/reject`, {
      method: 'POST',
      headers: { ...EMP, ...JSONH },
      body: JSON.stringify({ reason: 'nope' }),
    });
    expect(reject.status).toBe(403);
  });

  it('409s a second review decision instead of overwriting the first', async () => {
    // A re-approve would overwrite reviewedBy and erase who actually made the original call;
    // once the deferred commit hangs off this route, it would also double-commit payroll data.
    const { app, job } = await seed();
    const first = await app.request(`/api/extraction-jobs/${job.id}/approve`, {
      method: 'POST',
      headers: MGR,
    });
    expect(first.status).toBe(200);

    const again = await app.request(`/api/extraction-jobs/${job.id}/approve`, {
      method: 'POST',
      headers: MGR,
    });
    expect(again.status).toBe(409);

    // And a rejected job cannot be flipped to approved.
    const flip = await app.request(`/api/extraction-jobs/${job.id}/reject`, {
      method: 'POST',
      headers: { ...MGR, ...JSONH },
      body: JSON.stringify({ reason: 'changed my mind' }),
    });
    expect(flip.status).toBe(409);

    // The original decision stands.
    const after = await app.request(`/api/extraction-jobs/${job.id}`, { headers: MGR });
    expect((await after.json()) as { status: string }).toMatchObject({ status: 'approved' });
  });

  it('400s an unrecognized status filter instead of returning every job', async () => {
    // Silently ignoring `?status=aproved` returns approved jobs too, while the manager
    // believes they are looking at a filtered review queue.
    const { app } = await seed();
    const res = await app.request('/api/extraction-jobs?status=aproved', { headers: MGR });
    expect(res.status).toBe(400);
  });

  it('404s unknown and malformed ids', async () => {
    const { app } = await seed();
    expect((await app.request('/api/extraction-jobs/not-a-uuid', { headers: MGR })).status).toBe(404);
    expect(
      (await app.request('/api/extraction-jobs/00000000-0000-0000-0000-000000000000', { headers: MGR })).status,
    ).toBe(404);
  });
});
