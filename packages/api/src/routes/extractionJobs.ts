import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/testDb';
import type { AppEnv } from '../auth/types';
import { requireRole } from '../auth/middleware';
import { readJson, getOr404 } from '../http/validation';
import { extractionJobs } from '../schema';

const rejectSchema = z.object({ reason: z.string().min(1) });

type JobRow = typeof extractionJobs.$inferSelect;
function toDto(row: JobRow) {
  return {
    id: row.id,
    docType: row.docType,
    s3Key: row.s3Key,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    extracted: row.extractedJson,
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
  };
}

export function createExtractionJobRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireRole('manager', 'admin'));

  function idParam(c: Context<AppEnv>): string {
    const id = c.req.param('id');
    if (!id || !z.string().uuid().safeParse(id).success) {
      throw new HTTPException(404, { message: 'extraction job not found' });
    }
    return id;
  }

  const STATUSES = ['processing', 'needs_review', 'approved', 'rejected'] as const;

  routes.get('/', async (c) => {
    const filters: SQL[] = [];
    const status = c.req.query('status');
    if (status !== undefined) {
      // 400 on an unrecognized value rather than ignoring it. Silently dropping the filter
      // returns EVERY job — including approved ones — while the manager believes they are
      // looking at a filtered review queue. Matches the locationId filter convention.
      if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
        throw new HTTPException(400, {
          message: `status must be one of: ${STATUSES.join(', ')}`,
        });
      }
      filters.push(eq(extractionJobs.status, status as (typeof STATUSES)[number]));
    }
    const rows = filters.length
      ? await db.select().from(extractionJobs).where(and(...filters))
      : await db.select().from(extractionJobs);
    return c.json(rows.map(toDto));
  });

  routes.get('/:id', async (c) => {
    const id = idParam(c);
    const rows = await db.select().from(extractionJobs).where(eq(extractionJobs.id, id));
    return c.json(toDto(getOr404(rows, 'extraction job not found')));
  });

  /**
   * A review decision is only valid on a job still awaiting one.
   *
   * Without this, any job in any status could be decided repeatedly: a `rejected` job flipped
   * to `approved`, an `approved` job re-approved (overwriting `reviewedBy` and erasing who
   * actually made the original call), or a `processing` job decided out from under the Lambda
   * still writing it. Harmless today because committing extracted data into
   * daily_revenue/shifts is deliberately deferred — but that commit will hang off these
   * routes, where a double-approve becomes a double-commit of payroll data.
   */
  const DECIDABLE = ['processing', 'needs_review'] as const;

  async function assertDecidable(id: string): Promise<JobRow> {
    const [existing] = await db.select().from(extractionJobs).where(eq(extractionJobs.id, id));
    if (!existing) throw new HTTPException(404, { message: 'extraction job not found' });
    if (!DECIDABLE.includes(existing.status as (typeof DECIDABLE)[number])) {
      throw new HTTPException(409, {
        message: `extraction job is already ${existing.status} and cannot be reviewed again`,
      });
    }
    return existing;
  }

  // Approving records WHO approved it. This is the human half of the human-in-the-loop —
  // the extraction only ever proposed this data.
  routes.post('/:id/approve', async (c) => {
    const id = idParam(c);
    await assertDecidable(id);
    const [row] = await db
      .update(extractionJobs)
      .set({ status: 'approved', reviewedBy: c.get('principal').sub, updatedAt: new Date() })
      // Re-check the status in the UPDATE itself: between the read above and this write,
      // a concurrent decision could have landed. No row updated → someone else won.
      .where(and(eq(extractionJobs.id, id), inArray(extractionJobs.status, [...DECIDABLE])))
      .returning();
    if (!row) throw new HTTPException(409, { message: 'extraction job was already reviewed' });
    return c.json(toDto(row));
  });

  routes.post('/:id/reject', async (c) => {
    const id = idParam(c);
    const body = await readJson(c, rejectSchema);
    const existing = await assertDecidable(id);
    // `extractedJson` is always written as an object by the recorder; guard anyway, because
    // spreading an array would silently turn it into {0:…, 1:…} and corrupt the payload.
    const raw = existing.extractedJson;
    const payload: Record<string, unknown> =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const [row] = await db
      .update(extractionJobs)
      .set({
        status: 'rejected',
        reviewedBy: c.get('principal').sub,
        // Keep the reason with the job so the queue explains itself later.
        extractedJson: { ...payload, rejectionReason: body.reason },
        updatedAt: new Date(),
      })
      .where(and(eq(extractionJobs.id, id), inArray(extractionJobs.status, [...DECIDABLE])))
      .returning();
    if (!row) throw new HTTPException(409, { message: 'extraction job was already reviewed' });
    return c.json(toDto(row));
  });

  return routes;
}
