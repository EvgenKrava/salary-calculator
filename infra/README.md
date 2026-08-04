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
