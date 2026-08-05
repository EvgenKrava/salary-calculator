import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Region selection for the cross-account Bedrock client.
 *
 * Bedrock is consumed from a DIFFERENT AWS account than the one the Lambda runs in. The
 * bearer token carries its own identity, so no IAM is involved — the only thing that must be
 * right is the endpoint region. Getting it wrong surfaces as an auth or model-not-found error
 * that looks nothing like a region mismatch, which is why precedence is pinned here.
 */

const ctor = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrockMantle: class {
    constructor(opts: unknown) {
      ctor(opts);
    }
  },
}));

const { createBedrockClient } = await import('../src/bedrock');

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  delete process.env.BEDROCK_REGION;
  delete process.env.AWS_REGION_NAME;
  delete process.env.AWS_REGION;
  ctor.mockReset();
});
afterEach(() => {
  process.env = saved;
});

describe('createBedrockClient region selection', () => {
  it('prefers BEDROCK_REGION, so a cross-region Bedrock account works', () => {
    process.env.BEDROCK_REGION = 'us-west-2';
    process.env.AWS_REGION_NAME = 'eu-central-1';
    process.env.AWS_REGION = 'eu-central-1';
    createBedrockClient();
    expect(ctor).toHaveBeenCalledWith({ awsRegion: 'us-west-2' });
  });

  it('falls back to the app region when BEDROCK_REGION is unset', () => {
    process.env.AWS_REGION_NAME = 'us-east-1';
    createBedrockClient();
    expect(ctor).toHaveBeenCalledWith({ awsRegion: 'us-east-1' });
  });

  it('ignores a BLANK BEDROCK_REGION rather than pointing at no region', () => {
    // Terraform passes "" for an unset optional variable rather than omitting the key, so a
    // `??` chain would select the empty string and build a client with awsRegion: ''.
    process.env.BEDROCK_REGION = '';
    process.env.AWS_REGION_NAME = 'us-east-1';
    createBedrockClient();
    expect(ctor).toHaveBeenCalledWith({ awsRegion: 'us-east-1' });
  });

  it('ignores a whitespace-only value too', () => {
    process.env.BEDROCK_REGION = '   ';
    process.env.AWS_REGION = 'us-east-1';
    createBedrockClient();
    expect(ctor).toHaveBeenCalledWith({ awsRegion: 'us-east-1' });
  });

  it('trims a stray-whitespace region instead of sending it verbatim', () => {
    process.env.BEDROCK_REGION = ' us-east-1 ';
    createBedrockClient();
    expect(ctor).toHaveBeenCalledWith({ awsRegion: 'us-east-1' });
  });

  it('throws with an actionable message when no region is available', () => {
    expect(() => createBedrockClient()).toThrow(/BEDROCK_REGION/);
  });
});
