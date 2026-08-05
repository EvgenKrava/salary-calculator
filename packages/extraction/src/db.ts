import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

export interface JobRecord {
  docType: 'revenue' | 'schedule';
  s3Key: string;
  status: 'approved' | 'needs_review' | 'rejected';
  confidence: number | null;
  extracted: unknown;
  error?: string;
}

/**
 * Write one `extraction_jobs` row per invocation — including failures and refusals, so a
 * document is never silently dropped. Staged rows are written by the manager's review
 * action (the API routes), not here: this pipeline only ever *proposes* payroll data.
 */
export function createJobRecorder() {
  const region = process.env.AWS_REGION_NAME ?? process.env.AWS_REGION;
  const client = new RDSDataClient({ region });
  const resourceArn = process.env.DB_RESOURCE_ARN!;
  const secretArn = process.env.DB_SECRET_ARN!;
  const database = process.env.DB_NAME!;

  return async function recordJob(job: JobRecord): Promise<string> {
    const result = await client.send(
      new ExecuteStatementCommand({
        resourceArn,
        secretArn,
        database,
        sql: `INSERT INTO extraction_jobs (doc_type, s3_key, status, confidence, extracted_json)
              VALUES (:docType::doc_type, :s3Key, :status::extraction_status, :confidence, :extracted::jsonb)
              RETURNING id`,
        parameters: [
          { name: 'docType', value: { stringValue: job.docType } },
          { name: 's3Key', value: { stringValue: job.s3Key } },
          { name: 'status', value: { stringValue: job.status } },
          job.confidence === null
            ? { name: 'confidence', value: { isNull: true } }
            : { name: 'confidence', value: { doubleValue: job.confidence } },
          {
            name: 'extracted',
            value: { stringValue: JSON.stringify({ rows: job.extracted, error: job.error ?? null }) },
          },
        ],
      }),
    );
    return result.records?.[0]?.[0]?.stringValue ?? '';
  };
}
