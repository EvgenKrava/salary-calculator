import type { S3Event } from 'aws-lambda';
import { buildExtractionRequest } from './buildRequest';
import { parseExtractionResponse } from './parseResponse';
import type { DocType } from './schemas';
import { createBedrockClient, invokeModel } from './bedrock';
import { createJobRecorder, type JobRecord } from './db';
import { resolveMediaType } from './mediaType';

export interface HandlerDeps {
  getObject: (bucket: string, key: string) => Promise<{ body: Buffer; contentType: string }>;
  invokeModel: (request: unknown) => Promise<unknown>;
  recordJob: (job: JobRecord) => Promise<string>;
  threshold: number;
}

function docTypeFromKey(key: string): DocType | null {
  // Contract: uploads/<docType>/<uuid>-<filename>
  const match = /^uploads\/(revenue|schedule)\//.exec(key);
  return match ? (match[1] as DocType) : null;
}

/**
 * Dependency-injected so the whole flow is testable without AWS or Bedrock.
 *
 * The invariant this function protects: **every record produces exactly one
 * extraction_jobs row.** A refusal, a throttle, a bad key, an unreadable media type — all
 * become a `rejected` row rather than a thrown error, because a Lambda that throws leaves
 * the manager with a document that vanished and no queue entry explaining why.
 */
export function createHandler(deps: HandlerDeps) {
  return async function handler(event: S3Event): Promise<void> {
    for (const record of event.Records) {
      // The ENTIRE per-record body is inside try/catch, and nothing outside it can throw.
      // Previously the key decode and the unknown-prefix branch sat outside: a malformed
      // percent-sequence threw URIError, or that branch's recordJob threw, and the whole
      // loop aborted — so every *remaining* record in the batch got no row at all, which is
      // precisely the "document vanished with no queue entry" failure the invariant exists
      // to prevent.
      let key = record.s3.object.key;
      // `recorded` makes the recording step at-most-once. Without it, a recordJob that
      // committed its INSERT but failed while reading the response fell through to the catch,
      // which recorded a SECOND row for the same document — one approved, one rejected. There
      // is no UNIQUE constraint on extraction_jobs.s3_key to stop that.
      let recorded = false;
      let docType: DocType = 'revenue';

      const record1 = async (job: JobRecord): Promise<void> => {
        if (recorded) return;
        recorded = true;
        await deps.recordJob(job);
      };

      try {
        // S3 event keys are URL-encoded, and '+' means space.
        key = decodeURIComponent(key.replace(/\+/g, ' '));

        const resolved = docTypeFromKey(key);
        if (!resolved) {
          await record1({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: `key does not match uploads/<revenue|schedule>/: ${key}`,
          });
          continue;
        }
        docType = resolved;

        const object = await deps.getObject(bucket(record), key);
        const request = buildExtractionRequest({
          docType,
          media: {
            mediaType: resolveMediaType(object.contentType, key, object.body),
            // 'base64' never inserts line breaks; explicit for the API's no-newline rule.
            base64: object.body.toString('base64'),
          },
        });

        const response = await deps.invokeModel(request);
        const outcome = parseExtractionResponse(response, { docType, threshold: deps.threshold });

        if (outcome.kind === 'refused') {
          await record1({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: `model refused (category: ${outcome.category ?? 'unknown'})`,
          });
          continue;
        }

        if (outcome.kind === 'unusable') {
          await record1({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: outcome.reason,
            // Keep what the model actually said, so a manager can see why it was unusable
            // instead of only a one-line reason.
            raw: outcome.raw,
          });
          continue;
        }

        await record1({
          docType,
          s3Key: key,
          status: outcome.route,
          confidence: outcome.confidence,
          extracted: outcome.rows,
          // The prompt asks the model to explain anything illegible or ambiguous in `notes`.
          // Dropping it threw away the explanation exactly when a reviewer needs it.
          notes: outcome.notes,
        });
      } catch (err) {
        try {
          await record1({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: (err as Error).message,
          });
        } catch (recordErr) {
          // Last resort: the DB is unreachable. Log and move on, so the remaining records in
          // the batch still get processed rather than the whole invocation dying here.
          console.error('failed to record extraction job', { key, err, recordErr });
        }
      }
    }
  };
}

function bucket(record: S3Event['Records'][number]): string {
  return record.s3.bucket.name;
}

/**
 * Read the review threshold from the environment, failing loudly on a bad value.
 *
 * `Number(process.env.X ?? '0.85')` is wrong here in a way that matters: `??` only falls back
 * on `null`/`undefined`, so an **empty** `CONFIDENCE_THRESHOLD=""` — the most likely
 * misconfiguration, e.g. Terraform passing an unset variable — yields `Number('') === 0`,
 * which approves every extraction and silently switches off human review entirely. No error,
 * no log line. A cold-start throw is far better than months of unreviewed payroll data.
 */
export function readThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONFIDENCE_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return 0.85;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`CONFIDENCE_THRESHOLD must be a number in (0, 1]; got '${raw}'`);
  }
  return n;
}

/** The Lambda entrypoint named by the deployment contract (`extract.handler`). */
export const handler = async (event: S3Event): Promise<void> => {
  const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION_NAME ?? process.env.AWS_REGION });
  const bedrock = createBedrockClient();
  const recordJob = createJobRecorder();

  return createHandler({
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = Buffer.from(await res.Body!.transformToByteArray());
      return { body, contentType: res.ContentType ?? 'application/octet-stream' };
    },
    invokeModel: (request) => invokeModel(bedrock, request),
    recordJob,
    threshold: readThreshold(),
  })(event);
};
