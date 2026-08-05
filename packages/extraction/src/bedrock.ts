import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

/**
 * Bedrock client for the extraction Lambda.
 *
 * Auth is the `AWS_BEARER_TOKEN_BEDROCK` bearer token (a long-lived Bedrock API key) read
 * from the environment by the SDK — not SigV4 access keys.
 *
 * **Bedrock is consumed cross-account.** The token belongs to a principal in a different AWS
 * account from the one this Lambda runs in; a bearer token carries its own identity, so no
 * IAM role, trust policy, or resource policy is involved on this path. The only thing that
 * has to be right is the endpoint region.
 *
 * Region precedence, most specific first:
 *  1. `BEDROCK_REGION` — the Bedrock account's region, which need not match this stack's.
 *  2. `AWS_REGION_NAME` — this stack's region (Terraform's name for it, because `AWS_REGION`
 *     is reserved by the Lambda runtime and cannot be set).
 *  3. `AWS_REGION` — injected by the Lambda runtime.
 *
 * Falling back to the app's region is only correct while both happen to be the same region.
 * Setting `BEDROCK_REGION` explicitly is what makes a cross-region Bedrock account work —
 * otherwise the call goes to this account's endpoint and fails in a way that looks like an
 * auth or model-not-found error rather than a region mismatch.
 */
export function createBedrockClient() {
  const region = firstNonEmpty(
    process.env.BEDROCK_REGION,
    process.env.AWS_REGION_NAME,
    process.env.AWS_REGION,
  );
  if (!region) {
    throw new Error('BEDROCK_REGION (or AWS_REGION_NAME / AWS_REGION) must be set');
  }
  return new AnthropicBedrockMantle({ awsRegion: region });
}

/**
 * First value that is set and not blank.
 *
 * Blank matters: Terraform passes `""` for an unset optional variable rather than omitting
 * the key, so a `??` chain would select the empty string and construct a client pointed at no
 * region at all.
 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

export async function invokeModel(client: AnthropicBedrockMantle, request: unknown): Promise<unknown> {
  // The request body is built by buildExtractionRequest; the SDK forwards unknown keys, so
  // output_config passes through even where the typings lag.
  return client.messages.create(request as never);
}
