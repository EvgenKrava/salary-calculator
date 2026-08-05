import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/splitSql';
import { MIGRATIONS } from '../src/migrations';

/**
 * Statement splitting for the RDS Data API.
 *
 * `ExecuteStatement` takes exactly ONE statement and rejects a script with "Multistatements
 * aren't supported." PGlite's `client.exec()` — what every other test uses — accepts a whole
 * file, so the migration Lambda passed the entire suite and then applied 0 migrations against
 * the real cluster. These tests cover the cases where a naive `split(';')` would be wrong.
 */
describe('splitSqlStatements', () => {
  it('splits simple statements and drops the empty trailing one', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a final statement that has no terminating semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('does not split on a semicolon inside a line comment', () => {
    const sql = `-- a note; with a semicolon
SELECT 1;`;
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('does not split on a semicolon inside a block comment, including nested ones', () => {
    expect(splitSqlStatements('/* one; /* two; */ three; */ SELECT 1;')).toHaveLength(1);
  });

  it('does not split on a semicolon inside a string literal', () => {
    const out = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'");
  });

  it('handles a doubled quote as an escape, not a close', () => {
    const out = splitSqlStatements("SELECT 'it''s; fine'; SELECT 2;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("it''s; fine");
  });

  it('does not split inside a quoted identifier', () => {
    expect(splitSqlStatements('SELECT "weird;name" FROM t;')).toHaveLength(1);
  });

  it('does not split inside a dollar-quoted block', () => {
    // The common case this protects: a function body, which is mostly semicolons.
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql;`;
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('does not split inside a TAGGED dollar-quoted block', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1; $body$ LANGUAGE sql;`;
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('drops comment-only fragments, which the Data API rejects', () => {
    // A trailing comment after the last semicolon is common and must not be sent.
    expect(splitSqlStatements('SELECT 1;\n-- trailing note\n')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('/* only a comment */')).toEqual([]);
    expect(splitSqlStatements('')).toEqual([]);
  });

  it('splits every real migration into non-empty, non-comment-only statements', () => {
    // The end-to-end guard: whatever ships must be sendable one statement at a time.
    for (const [i, sql] of MIGRATIONS.entries()) {
      const statements = splitSqlStatements(sql);
      expect(statements.length, `migration ${i + 1} produced no statements`).toBeGreaterThan(0);
      for (const s of statements) {
        expect(s.trim().length).toBeGreaterThan(0);
        // No statement may itself contain a bare terminator — that would mean a missed split.
        const stripped = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(stripped.includes(';'), `unsplit statement in migration ${i + 1}: ${s.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it('preserves the full statement text, so nothing is silently dropped', () => {
    // Concatenating the split statements must recover every executable token.
    const norm = (x: string) => x.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/[;\s]/g, '');
    for (const sql of MIGRATIONS) {
      const joined = splitSqlStatements(sql).join(' ');
      expect(norm(joined)).toBe(norm(sql));
    }
  });
});
