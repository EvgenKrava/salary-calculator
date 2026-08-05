#!/usr/bin/env node
/**
 * Build the API and migration Lambda bundles.
 *
 * A script rather than an inline esbuild command so the two bundles share settings and so
 * the build fails loudly on esbuild warnings. `empty-import-meta` in particular is not
 * cosmetic here: it means a module used `import.meta.url` that esbuild replaced with `{}`,
 * which previously made the migration Lambda throw a TypeError at cold start. Treating
 * warnings as errors turns that class of bug into a failed build instead of a failed deploy.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // The Node 20 Lambda runtime provides the AWS SDK v3; bundling it would bloat the zip.
  external: ['@aws-sdk/*'],
  logLevel: 'warning',
};

const targets = [
  { entry: 'src/handler.ts', out: 'dist/api.js' },
  { entry: 'src/migrationHandler.ts', out: 'dist/migrate.js' },
];

let warnings = 0;
for (const { entry, out } of targets) {
  const result = await build({
    ...common,
    entryPoints: [join(here, entry)],
    outfile: join(here, out),
  });
  warnings += result.warnings.length;
}

if (warnings > 0) {
  // Anything that changes runtime semantics (import.meta elision, unresolved requires) shows
  // up here. Failing the build is cheaper than diagnosing it from CloudWatch logs.
  throw new Error(`esbuild reported ${warnings} warning(s) — fix them; bundle warnings have bitten this Lambda before`);
}

console.log(`bundled ${targets.map((t) => t.out).join(' and ')} with no warnings`);
