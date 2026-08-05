#!/usr/bin/env bash
# Build the Lambda bundles Terraform packages. Run before `terraform plan/apply`.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Regenerate the inlined migration SQL first. Each Lambda ships as a single .js with no
# sibling files, so the SQL must live inside the bundle; if a .sql file was edited without
# regenerating, the deploy would silently apply stale schema. Cheap and deterministic, and it
# leaves the tree dirty if it drifted — which is exactly the signal you want before an apply.
pnpm --filter @salary/core generate:migrations

pnpm --filter @salary/api bundle

# Only skip the extraction bundle when the package genuinely does not exist yet. Testing for
# the directory rather than swallowing stderr matters: `2>/dev/null || echo "not present yet"`
# reports a real compile error as an absent package, and Terraform then packages whatever
# stale dist/ happens to be lying around.
if [ -d packages/extraction ]; then
  pnpm --filter @salary/extraction bundle
else
  echo "note: packages/extraction not present yet — the extraction Lambda will package an empty bundle until it lands"
fi

ls -la packages/api/dist/
