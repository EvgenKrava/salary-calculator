#!/usr/bin/env bash
# Build the Lambda bundles Terraform packages. Run before `terraform plan/apply`.
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm --filter @salary/api bundle
pnpm --filter @salary/extraction bundle 2>/dev/null || \
  echo "note: @salary/extraction not present yet — the extraction Lambda will package an empty bundle until it lands"
ls -la packages/api/dist/
