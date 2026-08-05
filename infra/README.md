# Salary Calculator — Infrastructure

Terraform for the AWS infrastructure. Uses the `yevhenii` AWS profile and remote
state in S3 (see `bootstrap/`).

> **Cost: read [`cost.md`](cost.md) before the first `apply`.** This account is expected to
> run at **well under $1/month** — Bedrock is billed to a separate account (see step 2 of
> *Deploying the application*), so Claude usage never lands here. The $10 budget alarm is
> headroom, not a forecast. That estimate depends on specific settings — above all
> `db_min_acu = 0`, which lets Aurora pause to zero when idle. At `0.5` the cluster bills
> **~$44/month doing nothing**, over four times the whole budget. `cost.md` lists every
> cost-critical setting, the pre-apply checks, and how to verify real spend after 48 hours.
>
> `budget_alert_emails` has **no default** and is validated as non-empty, so `plan` fails
> until you set it — an AWS Budget with no subscriber looks like protection without being any.
> Note AWS Budgets **notify; they do not cap**. There is no hard spend limit on an AWS
> account. Creating the budget needs `budgets:ModifyBudget` on the deploying principal.

## First-time setup

**Step 0 — decide `project_name` and `region` before you run anything.** Both are baked
into the bootstrap's resource names AND into the main stack's `backend` block (which cannot
use variables), so changing either after the first `init` means editing `versions.tf` by
hand and migrating state. The defaults are `salary-calculator` / `us-east-1`.

```bash
cp terraform.tfvars.example terraform.tfvars   # set budget_alert_emails; review the COST block
```

1. Apply the bootstrap once (creates the encrypted, versioned state bucket). Pass the same
   `project_name`/`region` you chose above — the bootstrap has its own variables:
   ```bash
   cd bootstrap
   terraform init
   terraform apply -var="project_name=salary-calculator" -var="region=us-east-1"
   ```
2. Initialize the main stack, pointing at the bootstrap's state bucket
   (the name embeds your account id — take it from the bootstrap's `state_bucket` output):
   ```bash
   cd ..
   terraform init -backend-config="bucket=salary-calculator-tfstate-<ACCOUNT_ID>"
   ```
   Notes:
   - Backend blocks cannot use variables, so the state bucket's **region** is hardcoded in
     `versions.tf`. If you change `var.region`, edit the backend's `region` to match —
     otherwise the state stays in the old region while the resources move.
   - `.terraform/` is gitignored, so repeat this `-backend-config` on any new machine and on
     any `terraform init -reconfigure`.
   - State locking is S3-native (`use_lockfile = true`); there is no DynamoDB table.
3. Plan / apply. Use the wrapper rather than bare `terraform`: it supplies the Bedrock token
   from `AWS_BEARER_TOKEN_BEDROCK` in your environment, which `plan` now requires.
   ```bash
   ./deploy.sh plan
   ./deploy.sh apply
   ```
4. Smoke-test the Data API (this is the architecture's core premise — the Lambdas reach the
   DB over the Data API with no VPC attachment, so confirm it before building on it):
   ```bash
   aws rds-data execute-statement --profile yevhenii \
     --resource-arn "$(terraform output -raw db_cluster_arn)" \
     --secret-arn   "$(terraform output -raw db_secret_arn)" \
     --database     "$(terraform output -raw db_name)" \
     --sql "SELECT 1"
   ```
   One call proves the Data API path, the secret's JSON shape, and the engine version all
   work together.

All `apply` steps create real, billable AWS resources and are run by a human.

## Validation (no AWS credentials needed)

```bash
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
```

## Deploying the application

Run these after the infrastructure `apply` from the first-time setup above.

1. **Build the Lambda bundles** (Terraform packages pre-built files):
   ```bash
   ./infra/build/build.sh
   ```
   Each Lambda ships as one self-contained `.js`; nothing is read from disk at runtime. The
   migration SQL is inlined via `packages/core/src/migrations.generated.ts` — **committed,
   and regenerated with `pnpm --filter @salary/core generate:migrations` after editing any
   `db/migrations/*.sql`.** A stale generated file means the deployed schema silently differs
   from the one local tests run against; `packages/core/test/migrations.test.ts` fails on
   drift, and the build fails on any esbuild warning.
2. **The Bedrock token comes from your local environment — do not put it in a file.**

   **Bedrock is cross-account by design.** The app deploys to account `898836755334`, but
   Claude is billed to `677276119483` via a bearer token belonging to a principal there
   (`bedrock-api-user-at-677276119483`). This needs **no IAM wiring at all** — no role to
   assume, no trust policy, no resource policy — because a bearer token is authorized against
   the principal that created it, not against the caller's account or execution role. Verified
   by calling `https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages` directly with
   the token and getting HTTP 200 from `anthropic.claude-opus-5`.

   The consequence for cost: Claude usage never appears on this account's bill, which is why
   this account runs at well under $1/month (see [`cost.md`](cost.md)).

   The Bedrock account currently serves `us-east-1`, the same region as the app, so
   `bedrock_region` can stay empty. Set it if that ever diverges — otherwise the Lambda calls
   its own region's endpoint and fails with an auth/model-not-found error that looks nothing
   like a region mismatch.

   `AWS_BEARER_TOKEN_BEDROCK` is already exported for local development (the Anthropic SDK
   reads that name directly), so use the wrapper, which maps it to the `TF_VAR_` name
   Terraform expects:
   ```bash
   ./infra/deploy.sh plan
   ./infra/deploy.sh apply
   ```
   Equivalent by hand: `export TF_VAR_bedrock_bearer_token="$AWS_BEARER_TOKEN_BEDROCK"`.

   This keeps one copy of a long-lived credential instead of two, with nothing sensitive in
   plaintext inside the repo directory. `plan` fails with an actionable message if the token
   is missing — previously the deploy succeeded and every Bedrock call then failed with an
   auth error only visible in CloudWatch after someone uploaded a document.

   Generate a key with `aws bedrock create-api-key` **in the Bedrock account**, and **scope
   the permissions of the identity you generate it under** — that principal's Bedrock
   permissions are the entire blast radius if the token leaks. There is deliberately no
   `bedrock:*` statement in `iam.tf`: a grant naming foundation models in *this* account would
   have granted nothing while reading as a least-privilege boundary that does not exist.

   **Rotate the token if it has ever been pasted into a chat, ticket, or terminal transcript.**
   It is a long-lived credential with no expiry, and it is stored in plaintext in the Terraform
   S3 state and readable from the Lambda's configuration by anyone holding
   `lambda:GetFunctionConfiguration`. Rotating is one command in the Bedrock account:
   ```bash
   aws bedrock create-api-key   # in account 677276119483
   aws bedrock delete-api-key --api-key-id <old>
   ```
   Then re-export `AWS_BEARER_TOKEN_BEDROCK` and re-run `./infra/deploy.sh apply`.
3. **Apply**, then create the schema — this is a one-time step per database:
   ```bash
   ./infra/deploy.sh apply
   aws lambda invoke --profile yevhenii \
     --function-name "$(terraform output -raw migrate_function_name)" /dev/stdout
   ```
   A successful response reports `{"applied":3,"errors":[]}`. **Do not re-invoke it** —
   the migrations are not idempotent and a second run fails on the already-created objects.
4. **Smoke-test the API and the Data API path in one call:**
   ```bash
   curl "$(terraform output -raw api_url)/health"
   ```
   `{"status":"ok"}` means the Lambda, the gateway, and the bundle are wired correctly. Then
   confirm the Data API premise (the whole reason no Lambda is in the VPC):
   ```bash
   aws rds-data execute-statement --profile yevhenii \
     --resource-arn "$(terraform output -raw db_cluster_arn)" \
     --secret-arn   "$(terraform output -raw db_secret_arn)" \
     --database     "$(terraform output -raw db_name)" \
     --sql "SELECT count(*) FROM levels"
   ```
5. **Create the first admin user** (there is no public sign-up):
   ```bash
   POOL=$(terraform output -raw cognito_user_pool_id)
   aws cognito-idp admin-create-user --profile yevhenii \
     --user-pool-id "$POOL" --username you@example.com
   aws cognito-idp admin-add-user-to-group --profile yevhenii \
     --user-pool-id "$POOL" --username you@example.com --group-name admin
   ```
6. **Deploy the frontend** once it is built:
   ```bash
   aws s3 sync apps/web/dist "s3://$(terraform output -raw frontend_bucket)/" --delete --profile yevhenii
   aws cloudfront create-invalidation --profile yevhenii \
     --distribution-id "$(terraform output -raw cloudfront_distribution_id)" --paths '/*'
   ```

### Cost note

Full breakdown, the cost-critical settings, and the pre/post-apply checks are in
[`cost.md`](cost.md). In short: CloudFront and S3 are pennies at this scale, and the only
line item that can quietly dominate the bill is Aurora Serverless v2. `db_min_acu` now
defaults to **0**, so the cluster auto-pauses to zero ACUs when idle (~15 s resume on the next
request) instead of billing ~$44/month to sit there. Expected total is ~$2–4/month, against a
$10 budget alarm.
