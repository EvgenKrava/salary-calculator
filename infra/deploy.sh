#!/usr/bin/env bash
#
# Run Terraform with the Bedrock token taken from the local environment.
#
# The extraction Lambda needs a Bedrock API key. It is already exported locally as
# AWS_BEARER_TOKEN_BEDROCK (the name the Anthropic SDK reads), so this maps that one copy to
# the TF_VAR_ name Terraform expects instead of duplicating a long-lived credential into
# terraform.tfvars, where it would sit in plaintext on disk inside the repo directory.
#
# Usage:
#   ./infra/deploy.sh plan
#   ./infra/deploy.sh apply
#   ./infra/deploy.sh output -raw api_url
#
# Any Terraform subcommand and flags pass straight through.
set -euo pipefail

cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  echo "usage: $0 <terraform-subcommand> [args...]   e.g. $0 plan" >&2
  exit 2
fi

if [ -z "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
  cat >&2 <<'MSG'
error: AWS_BEARER_TOKEN_BEDROCK is not set in this shell.

It is the Bedrock API key the extraction Lambda uses. Export it (it is normally set in
~/.zshrc for local development), or generate one:

    aws bedrock create-api-key --profile yevhenii

Note: scope the permissions of the identity you generate it under. A bearer token is
authorized against the principal that created it, NOT against the Lambda's execution role,
so the anthropic.* scoping in iam.tf does not bound this credential (see cost.md / iam.tf).
MSG
  exit 1
fi

# Terraform reads any TF_VAR_-prefixed variable automatically. Exported only for the child
# process; never written to disk, never echoed.
export TF_VAR_bedrock_bearer_token="$AWS_BEARER_TOKEN_BEDROCK"

echo "using AWS_BEARER_TOKEN_BEDROCK from the environment (${#AWS_BEARER_TOKEN_BEDROCK} chars, value not shown)"
exec terraform "$@"
