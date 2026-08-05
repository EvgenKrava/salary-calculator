import type { S3Event } from 'aws-lambda';
import { buildExtractionRequest } from './buildRequest';
import { parseExtractionResponse } from './parseResponse';
import type { DocType } from './schemas';
import { createBedrockClient, invokeModel } from './bedrock';
import { createJobRecorder, type JobRecord } from './db';

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
      const bucket = record.s3.bucket.name;
      // S3 event keys are URL-encoded, and '+' means space.
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

      const docType = docTypeFromKey(key);
      if (!docType) {
        await deps.recordJob({
          docType: 'revenue',
          s3Key: key,
          status: 'rejected',
          confidence: null,
          extracted: null,
          error: `key does not match uploads/<revenue|schedule>/: ${key}`,
        });
        continue;
      }

      try {
        const object = await deps.getObject(bucket, key);
        const request = buildExtractionRequest({
          docType,
          media: {
            mediaType: object.contentType,
            // 'base64' never inserts line breaks; explicit for the API's no-newline rule.
            base64: object.body.toString('base64'),
          },
        });

        const response = await deps.invokeModel(request);
        const outcome = parseExtractionResponse(response, { docType, threshold: deps.threshold });

        if (outcome.kind === 'refused') {
          await deps.recordJob({
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
          await deps.recordJob({
            docType,
            s3Key: key,
            status: 'rejected',
            confidence: null,
            extracted: null,
            error: outcome.reason,
          });
          continue;
        }

        await deps.recordJob({
          docType,
          s3Key: key,
          status: outcome.route,
          confidence: outcome.confidence,
          extracted: outcome.rows,
        });
      } catch (err) {
        await deps.recordJob({
          docType,
          s3Key: key,
          status: 'rejected',
          confidence: null,
          extracted: null,
          error: (err as Error).message,
        });
      }
    }
  };
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
    threshold: Number(process.env.CONFIDENCE_THRESHOLD ?? '0.85'),
  })(event);
};
