import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `db.ts` is the only module that talks to real infrastructure, and it was entirely
 * untested: the SQL text, the five parameter names, the `stringValue`-for-jsonb choice, and
 * the `::doc_type` / `::extraction_status` enum casts were all unverified. A typo in a
 * parameter name would surface only at deploy — and because a recordJob failure means the
 * document gets no queue row, the manager would see an empty queue while logs filled with
 * errors. Stub the client; no network needed.
 */

const send = vi.fn();
vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class {
    send = send;
  },
  ExecuteStatementCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const ENV = {
  AWS_REGION_NAME: 'eu-central-1',
  DB_RESOURCE_ARN: 'arn:aws:rds:eu-central-1:1:cluster:c',
  DB_SECRET_ARN: 'arn:aws:secretsmanager:eu-central-1:1:secret:s',
  DB_NAME: 'salary',
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  send.mockReset();
  send.mockResolvedValue({ records: [[{ stringValue: 'job-uuid' }]] });
});
afterEach(() => {
  process.env = saved;
});

async function recorder() {
  const { createJobRecorder } = await import('../src/db');
  return createJobRecorder();
}

function inputOf(call: unknown[]): {
  sql: string;
  parameters: { name: string; value: Record<string, unknown> }[];
  resourceArn: string;
  secretArn: string;
  database: string;
} {
  return (call[0] as { input: never }).input;
}

describe('createJobRecorder', () => {
  it('sends the enum casts the schema requires and returns the new id', async () => {
    const record = await recorder();
    const id = await record({
      docType: 'revenue',
      s3Key: 'uploads/revenue/a.jpg',
      status: 'needs_review',
      confidence: 0.42,
      extracted: [{ amount: '10.00' }],
      notes: 'smudged',
    });

    expect(id).toBe('job-uuid');
    const input = inputOf(send.mock.calls[0]);
    // The casts must name enums that exist in 0001_init.sql; without them the Data API
    // rejects a text parameter for an enum column.
    expect(input.sql).toContain(':docType::doc_type');
    expect(input.sql).toContain(':status::extraction_status');
    expect(input.sql).toContain(':extracted::jsonb');
    expect(input.sql).toContain('RETURNING id');
    expect(input.resourceArn).toBe(ENV.DB_RESOURCE_ARN);
    expect(input.secretArn).toBe(ENV.DB_SECRET_ARN);
    expect(input.database).toBe(ENV.DB_NAME);
  });

  it('binds every named parameter the SQL references', async () => {
    const record = await recorder();
    await record({
      docType: 'schedule',
      s3Key: 'uploads/schedule/b.png',
      status: 'approved',
      confidence: 0.95,
      extracted: [],
    });

    const input = inputOf(send.mock.calls[0]);
    const names = input.parameters.map((p) => p.name).sort();
    expect(names).toEqual(['confidence', 'docType', 'extracted', 's3Key', 'status']);
    // Every :name placeholder must have a binding, or the Data API 400s. `(?<!:)` excludes
    // the `::type` cast suffixes, which are not placeholders.
    const placeholders = [...input.sql.matchAll(/(?<!:):([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const name of placeholders) expect(names).toContain(name);
  });

  it('sends a numeric confidence as doubleValue', async () => {
    const record = await recorder();
    await record({ docType: 'revenue', s3Key: 'k', status: 'approved', confidence: 0.87, extracted: [] });
    const p = inputOf(send.mock.calls[0]).parameters.find((x) => x.name === 'confidence');
    expect(p!.value).toEqual({ doubleValue: 0.87 });
  });

  it('sends a null confidence as isNull, not as 0', async () => {
    // A rejected job has no confidence. Writing 0 would be a *claim* about the read.
    const record = await recorder();
    await record({ docType: 'revenue', s3Key: 'k', status: 'rejected', confidence: null, extracted: null, error: 'boom' });
    const p = inputOf(send.mock.calls[0]).parameters.find((x) => x.name === 'confidence');
    expect(p!.value).toEqual({ isNull: true });
  });

  it('persists notes, raw, and error inside extracted_json for the reviewer', async () => {
    const record = await recorder();
    await record({
      docType: 'revenue',
      s3Key: 'k',
      status: 'rejected',
      confidence: null,
      extracted: null,
      error: 'response was not valid JSON',
      raw: '{oops',
      notes: 'left column illegible',
    });
    const p = inputOf(send.mock.calls[0]).parameters.find((x) => x.name === 'extracted');
    expect(JSON.parse(p!.value.stringValue as string)).toEqual({
      rows: null,
      error: 'response was not valid JSON',
      notes: 'left column illegible',
      raw: '{oops',
    });
  });

  it('propagates a Data API failure so the handler records or logs it', async () => {
    send.mockRejectedValueOnce(new Error('ThrottlingException'));
    const record = await recorder();
    await expect(
      record({ docType: 'revenue', s3Key: 'k', status: 'approved', confidence: 0.9, extracted: [] }),
    ).rejects.toThrow('ThrottlingException');
  });
});
