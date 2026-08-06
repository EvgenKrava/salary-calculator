import { EXTRACTION_TOOL } from '../src/buildRequest';

/**
 * Fake Bedrock responses in the shape the endpoint actually returns.
 *
 * Shared rather than inlined per test file because the wire shape changed once already and
 * silently: the request used to ask for `output_config.format`, every test built a matching
 * JSON-text response, and the suite was green while Bedrock 400'd every real invocation
 * (`output_config.format: Extra inputs are not permitted`). With the shape written out in
 * three files, nothing pointed at the divergence. One definition means the next change to the
 * wire format breaks compilation instead of passing.
 *
 * Bedrock's Mantle endpoint supports none of the structured-output mechanisms, so the payload
 * arrives as the input to a forced `record_extraction` tool call — see src/buildRequest.ts.
 */
export function toolUseResponse(payload: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: EXTRACTION_TOOL,
        // Round-tripped through JSON because the SDK parses the wire body: tool input can only
        // ever hold JSON-representable values, so a test must not smuggle in a live JS object.
        input: JSON.parse(JSON.stringify(payload)),
      },
    ],
  };
}

/** A clean, high-confidence single-row revenue read — the default happy path. */
export const GOOD_REVENUE = {
  rows: [{ locationName: '1', date: '2026-05-05', amount: '1000.00', confidence: 0.95 }],
  confidence: 0.95,
  notes: '',
};
