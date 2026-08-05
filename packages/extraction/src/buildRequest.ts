import { schemaFor, type DocType } from './schemas';

const SUPPORTED_MEDIA = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/** Bedrock model IDs carry the `anthropic.` prefix; the bare ID 400s here. */
export const MODEL_ID = 'anthropic.claude-opus-5';

/**
 * Request size limit. The API caps a single request at 32 MB; the payload is measured as
 * base64 because that is what actually travels, and base64 inflates bytes by ~4/3. A little
 * headroom is left for the prompt and JSON envelope.
 */
export const MAX_REQUEST_MB = 31;
const MAX_REQUEST_BYTES = MAX_REQUEST_MB * 1_048_576;

export interface ExtractionMedia {
  mediaType: string;
  base64: string;
}

/** A single content block (image/document/text). Carries `type` plus block-specific keys. */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface MessageRequest {
  // Index signature lets call sites assert this to Record<string, unknown> (see tests) to
  // check for absent 400-triggering keys, without weakening the named fields below.
  [key: string]: unknown;
  model: string;
  max_tokens: number;
  output_config: { effort: string; format: { type: 'json_schema'; schema: unknown } };
  messages: { role: 'user'; content: ContentBlock[] }[];
}

const INSTRUCTIONS = `You are transcribing a hand-written document from a coffee-shop chain so a manager can verify it.

Transcribe only what is actually written. Do not guess, infer, or complete values that are not legible — an omitted row and a low confidence score are both far better than an invented number, because these figures determine what people are paid.

For every row, give a confidence between 0 and 1 for that specific row. Give a separate overall confidence for the document. Use the notes field for anything illegible, ambiguous, crossed out, or otherwise unexpected.

Copy amounts, dates, names and times exactly as they appear, as strings. Do not reformat, round, or convert them.`;

/**
 * Build the Bedrock request body for one document. Pure — no network, no AWS, no clock.
 *
 * Notable constraints encoded here (all confirmed against the claude-api skill):
 * - `max_tokens` is deliberately generous: Opus 5 thinks by default and thinking shares
 *   this budget with the response, so a tight value truncates the answer mid-JSON.
 * - No `temperature`/`top_p`/`top_k`/`budget_tokens` — each returns a 400 on Opus 5.
 * - PDFs and images use different block types, and the media block must precede the text.
 */
export function buildExtractionRequest(input: {
  docType: DocType;
  media: ExtractionMedia;
  /** Override the model. Defaults to MODEL_ID; the handler passes BEDROCK_MODEL_ID. */
  modelId?: string;
}): MessageRequest {
  const { docType, media } = input;
  // Terraform sets BEDROCK_MODEL_ID; ignoring it meant changing the variable silently did
  // nothing, so a model rollback would appear to deploy and have no effect.
  const modelId = input.modelId?.trim() || MODEL_ID;

  if (!SUPPORTED_MEDIA.has(media.mediaType)) {
    throw new Error(`unsupported media type '${media.mediaType}' for extraction`);
  }
  if (/[\r\n]/.test(media.base64)) {
    throw new Error('base64 payload must not contain a newline — the API rejects it');
  }
  // The API caps a request at 32 MB. Checking here turns an opaque Bedrock 400 into a reason
  // the manager can act on ("photograph it in two halves") instead of "api error 400".
  if (media.base64.length > MAX_REQUEST_BYTES) {
    const mb = (media.base64.length / 1_048_576).toFixed(1);
    throw new Error(
      `document is too large to extract (${mb} MB base64, limit ${MAX_REQUEST_MB} MB) — ` +
        `re-upload it at a lower resolution or split it into parts`,
    );
  }

  const mediaBlock =
    media.mediaType === 'application/pdf'
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: media.base64 },
        }
      : {
          type: 'image',
          source: { type: 'base64', media_type: media.mediaType, data: media.base64 },
        };

  return {
    model: modelId,
    max_tokens: 16000,
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: schemaFor(docType) },
    },
    messages: [
      {
        role: 'user',
        // Media first, text last — the documented ordering for document input.
        content: [mediaBlock, { type: 'text', text: INSTRUCTIONS }],
      },
    ],
  };
}
