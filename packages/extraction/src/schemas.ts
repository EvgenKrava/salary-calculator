export type DocType = 'revenue' | 'schedule';

/**
 * Structured-output schemas for `output_config.format`.
 *
 * Two deliberate choices carried through both schemas:
 * - Every extracted row carries its own `confidence`, not just the document. One illegible
 *   figure on an otherwise clean page should send that row to review, not the whole page.
 * - Amounts and dates are strings, not numbers/dates. The model transcribes what it sees;
 *   parsing and validation happen in our code where a failure is visible, rather than
 *   being silently coerced by the model.
 */
export const REVENUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'confidence', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['locationName', 'date', 'amount', 'confidence'],
        properties: {
          locationName: { type: 'string', description: 'Location name or number as written' },
          date: { type: 'string', description: 'The date as written, e.g. "5" or "2026-05-05"' },
          amount: { type: 'string', description: 'The revenue figure exactly as written' },
          confidence: { type: 'number', description: '0-1 confidence for THIS row' },
        },
      },
    },
    confidence: { type: 'number', description: '0-1 confidence for the document overall' },
    notes: { type: 'string', description: 'Anything illegible, ambiguous, or unexpected' },
  },
} as const;

export const SCHEDULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'confidence', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['employeeName', 'date', 'locationName', 'confidence'],
        properties: {
          employeeName: { type: 'string', description: 'The name as written' },
          date: { type: 'string', description: 'The date as written' },
          locationName: { type: 'string', description: 'Location name or number as written' },
          startsAt: { type: 'string', description: 'HH:MM if the document states it, else empty' },
          endsAt: { type: 'string', description: 'HH:MM if the document states it, else empty' },
          confidence: { type: 'number', description: '0-1 confidence for THIS row' },
        },
      },
    },
    confidence: { type: 'number' },
    notes: { type: 'string' },
  },
} as const;

export function schemaFor(docType: DocType) {
  return docType === 'revenue' ? REVENUE_SCHEMA : SCHEDULE_SCHEMA;
}
