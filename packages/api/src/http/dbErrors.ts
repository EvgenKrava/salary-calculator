/** True if the error is a Postgres unique-constraint violation (works across PGlite and RDS Data API). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  if (e?.code === '23505' || e?.cause?.code === '23505') return true;
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  return /duplicate key value|unique constraint|23505/i.test(msg);
}