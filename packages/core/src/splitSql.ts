/**
 * Split a SQL script into individual statements.
 *
 * **Why this exists:** the RDS Data API's `ExecuteStatement` accepts exactly ONE statement and
 * rejects a multi-statement script with `Multistatements aren't supported.` PGlite's
 * `client.exec()` — what the tests use — happily accepts a whole file, so the migration Lambda
 * built clean, passed every test, and then failed on the real database with 0 migrations
 * applied. This function is the bridge between those two behaviours.
 *
 * A naive `sql.split(';')` is wrong and would break as soon as a migration contains a
 * semicolon that is not a statement terminator. This tracks the lexical states where `;` is
 * just a character:
 *
 * - `-- line comments` (the existing migrations are full of prose that could contain one)
 * - `/* block comments *\/`, which Postgres allows to nest
 * - `'string literals'`, including the `''` escape
 * - `"quoted identifiers"`
 * - `$$dollar-quoted blocks$$` and tagged `$tag$…$tag$`, used by function bodies
 *
 * Statements are returned trimmed, with empty ones dropped, in source order.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment: consume to end of line, keeping it with the statement so error
    // messages and any future logging still show the explanatory prose.
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ — Postgres nests these, so count depth rather than finding the
    // first closer.
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // 'string literal' or "quoted identifier". A doubled quote is an escape, not a close.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) j += 2; // escaped quote
          else {
            j += 1;
            break;
          }
        } else {
          j += 1;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // $$ or $tag$ dollar-quoted block — the standard way to write a function body, where
    // semicolons are extremely common and definitely not terminators.
    if (ch === '$') {
      const open = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (open) {
        const tag = open[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ';') {
      statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  // Trailing statement without a terminating semicolon.
  if (current.trim()) statements.push(current.trim());

  // Drop entries that are only whitespace or only comments — sending a comment-only string to
  // ExecuteStatement is an error, and a trailing comment block after the last `;` is common.
  return statements.filter((s) => s.length > 0 && !isCommentOnly(s));
}

/** True when a statement contains no executable SQL, only comments and whitespace. */
function isCommentOnly(statement: string): boolean {
  const stripped = statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim();
  return stripped.length === 0;
}
