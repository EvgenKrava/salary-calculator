import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load-time checks on the built Lambda bundles.
 *
 * These exist because the migration Lambda once built cleanly, passed every source-level
 * test, and still crashed at cold start: `@salary/core/migrations` used
 * `dirname(fileURLToPath(import.meta.url))`, which esbuild's CJS output turns into
 * `fileURLToPath(undefined)`. Nothing that runs from source can catch that — Vitest loads
 * ESM, where `import.meta.url` is real. Only requiring the actual bundle does.
 *
 * The bundle is copied to a temp dir with no `package.json` first. That matters: inside the
 * workspace, `packages/api/package.json` declares `"type": "module"`, so Node parses
 * `dist/*.js` as ESM and `module.exports` silently yields no exports. The Lambda zip has no
 * `package.json`, so `.js` is CJS there. Testing in place would give a false failure.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const distDir = join(pkgRoot, 'dist');

let sandbox: string;

beforeAll(() => {
  if (!existsSync(join(distDir, 'migrate.js')) || !existsSync(join(distDir, 'api.js'))) {
    execFileSync('node', [join(pkgRoot, 'build.mjs')], { cwd: pkgRoot, stdio: 'inherit' });
  }
  sandbox = mkdtempSync(join(tmpdir(), 'salary-bundle-'));
  cpSync(join(distDir, 'migrate.js'), join(sandbox, 'migrate.js'));
  cpSync(join(distDir, 'api.js'), join(sandbox, 'api.js'));
}, 120_000);

/**
 * Require a bundle in a fresh Node process with the AWS SDK stubbed, mirroring the Lambda
 * runtime (which provides `@aws-sdk/*` rather than the bundle carrying it).
 */
function requireBundle(file: string, extra = ''): string {
  const script = `
    const Module = require('module');
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req.startsWith('@aws-sdk/')) return require.resolve('path');
      return orig.call(this, req, ...rest);
    };
    const m = require(${JSON.stringify(join(sandbox, file))});
    ${extra}
    console.log('typeof handler=' + typeof m.handler);
  `;
  return execFileSync('node', ['-e', script], { encoding: 'utf8' });
}

describe('lambda bundles', () => {
  it('migrate.js loads and exports a handler', () => {
    // Cold-start regression: this threw
    // 'TypeError: The "path" argument must be of type string ... Received undefined'.
    expect(requireBundle('migrate.js')).toContain('typeof handler=function');
  });

  it('migrate.js carries the migration SQL inside the bundle', () => {
    // Terraform packages a single .js file (archive_file `source_file`), so nothing beside
    // it ships. If the SQL is not inlined, the Lambda fails with ENOENT at runtime.
    const bundle = readFileSync(join(distDir, 'migrate.js'), 'utf8');
    for (const table of ['levels', 'locations', 'employees', 'shifts', 'daily_revenue', 'salary_runs']) {
      expect(bundle, `CREATE TABLE ${table} missing from bundle`).toContain(`CREATE TABLE ${table}`);
    }
    expect(bundle).toContain('location_shift_slots'); // 0003 present, not just 0001
  });

  it('does not emit an empty import.meta shim', () => {
    // esbuild's tell for the original crash. `var import_meta = {}` means some module still
    // reads `import.meta.url` and will get undefined at runtime.
    for (const file of ['migrate.js', 'api.js']) {
      expect(readFileSync(join(distDir, file), 'utf8')).not.toMatch(/var import_meta\s*=\s*\{\}/);
    }
  });

  it('api.js loads far enough to validate its environment', () => {
    // With no env vars the config check should be what fails — proving module init ran
    // rather than dying earlier on a bundling defect.
    let output = '';
    try {
      output = requireBundle('api.js');
    } catch (err) {
      output = String((err as { stderr?: string; message?: string }).stderr ?? (err as Error).message);
    }
    expect(output).toMatch(/check env vars|typeof handler=function/);
  });
});
