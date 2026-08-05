/** True if the error is a Postgres unique-constraint violation (works across PGlite and RDS Data API). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  if (e?.code === '23505' || e?.cause?.code === '23505') return true;
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  return /duplicate key value|unique constraint|23505/i.test(msg);
}

/**
 * True if the error is a Postgres foreign-key violation.
 *
 * Matches on both the SQLSTATE and the message text because the two drivers surface it
 * differently: PGlite sets `code`, while the RDS Data API wraps it in a
 * `DatabaseErrorException` whose detail lives only in the message string.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  if (e?.code === '23503' || e?.cause?.code === '23503') return true;
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  return /foreign key constraint|23503/i.test(msg);
}
