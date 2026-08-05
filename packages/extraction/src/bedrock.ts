import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

/**
 * Bedrock client for the extraction Lambda.
 *
 * Auth is the `AWS_BEARER_TOKEN_BEDROCK` bearer token (a long-lived Bedrock API key) read
 * from the environment by the SDK — not SigV4 access keys. `AWS_REGION` is populated by
 * the Lambda runtime; `AWS_REGION_NAME` is the contract's explicit fallback because
 * `AWS_REGION` is reserved and cannot be set by Terraform.
 */
export function createBedrockClient() {
  const region = process.env.AWS_REGION_NAME ?? process.env.AWS_REGION;
  if (!region) throw new Error('AWS_REGION_NAME (or AWS_REGION) must be set');
  return new AnthropicBedrockMantle({ awsRegion: region });
}

export async function invokeModel(client: AnthropicBedrockMantle, request: unknown): Promise<unknown> {
  // The request body is built by buildExtractionRequest; the SDK forwards unknown keys, so
  // output_config passes through even where the typings lag.
  return client.messages.create(request as never);
}
