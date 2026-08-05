# Salary Calculator — Infrastructure

Terraform for the AWS infrastructure. Uses the `yevhenii` AWS profile and remote
state in S3 (see `bootstrap/`).

## First-time setup

**Step 0 — decide `project_name` and `region` before you run anything.** Both are baked
into the bootstrap's resource names AND into the main stack's `backend` block (which cannot
use variables), so changing either after the first `init` means editing `versions.tf` by
hand and migrating state. The defaults are `salary-calculator` / `us-east-1`.

```bash
cp terraform.tfvars.example terraform.tfvars   # edit project_name / region / ACUs here
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
3. Plan / apply:
   ```bash
   terraform plan
   terraform apply
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
2. **Supply the Bedrock token.** Add to `terraform.tfvars` (gitignored):
   ```hcl
   bedrock_bearer_token = "<Bedrock API key>"
   ```
   Or export `TF_VAR_bedrock_bearer_token`. Without it the extraction Lambda deploys but
   every Bedrock call fails with an auth error.
3. **Apply**, then create the schema — this is a one-time step per database:
   ```bash
   terraform apply
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

CloudFront and S3 are pennies at this scale; the standing cost is Aurora Serverless v2. At
`db_min_acu = 0.5` the cluster never scales to zero — setting `db_min_acu = 0` enables
auto-pause on the resolved 15.10+ engine and is recommended for a dev deployment.
