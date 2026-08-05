import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, type SQL } from 'drizzle-orm';
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

  routes.get('/', async (c) => {
    const filters: SQL[] = [];
    const status = c.req.query('status');
    if (
      status === 'processing' ||
      status === 'needs_review' ||
      status === 'approved' ||
      status === 'rejected'
    ) {
      filters.push(eq(extractionJobs.status, status));
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

  // Approving records WHO approved it. This is the human half of the human-in-the-loop —
  // the extraction only ever proposed this data.
  routes.post('/:id/approve', async (c) => {
    const id = idParam(c);
    const [row] = await db
      .update(extractionJobs)
      .set({ status: 'approved', reviewedBy: c.get('principal').sub, updatedAt: new Date() })
      .where(eq(extractionJobs.id, id))
      .returning();
    if (!row) throw new HTTPException(404, { message: 'extraction job not found' });
    return c.json(toDto(row));
  });

  routes.post('/:id/reject', async (c) => {
    const id = idParam(c);
    const body = await readJson(c, rejectSchema);
    const [existing] = await db.select().from(extractionJobs).where(eq(extractionJobs.id, id));
    if (!existing) throw new HTTPException(404, { message: 'extraction job not found' });
    const payload = (existing.extractedJson ?? {}) as Record<string, unknown>;
    const [row] = await db
      .update(extractionJobs)
      .set({
        status: 'rejected',
        reviewedBy: c.get('principal').sub,
        // Keep the reason with the job so the queue explains itself later.
        extractedJson: { ...payload, rejectionReason: body.reason },
        updatedAt: new Date(),
      })
      .where(eq(extractionJobs.id, id))
      .returning();
    return c.json(toDto(row));
  });

  return routes;
}
