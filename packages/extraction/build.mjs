#!/usr/bin/env node
/**
 * Build the extraction Lambda bundle.
 *
 * Mirrors `packages/api/build.mjs`, and exists for the same reason: **any esbuild warning
 * fails the build.** `empty-import-meta` in particular is not cosmetic — it means a module
 * used `import.meta.url`, which esbuild's CJS output replaces with `{}`, so the value is
 * `undefined` at runtime. That exact warning was present and ignored while the migration
 * Lambda crashed at cold start after a clean `terraform apply`.
 *
 * This package has no `import.meta` or filesystem reads today. The guard is here so a future
 * one fails loudly at build time instead of in CloudWatch.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'src/handler.ts')],
  outfile: join(here, 'dist/extract.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // The Node 20 Lambda runtime provides the AWS SDK v3; bundling it would bloat the zip.
  external: ['@aws-sdk/*'],
  logLevel: 'warning',
});

if (result.warnings.length > 0) {
  throw new Error(
    `esbuild reported ${result.warnings.length} warning(s) — fix them; bundle warnings have caused a cold-start crash on this project before`,
  );
}

console.log('bundled dist/extract.js with no warnings');
