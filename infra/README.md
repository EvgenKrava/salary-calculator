# Salary Calculator — Infrastructure

Terraform for the AWS infrastructure. Uses the `yevhenii` AWS profile and remote
state in S3 (see `bootstrap/`).

## First-time setup

1. Apply the bootstrap once (creates the state bucket + lock table):
   ```bash
   cd bootstrap && terraform init && terraform apply
   ```
2. Initialize the main stack, pointing at the bootstrap's state bucket
   (name embeds your account id — take it from the bootstrap output):
   ```bash
   cd ..
   terraform init -backend-config="bucket=salary-calculator-tfstate-<ACCOUNT_ID>"
   ```
3. Plan / apply:
   ```bash
   cp terraform.tfvars.example terraform.tfvars   # edit as needed
   terraform plan
   terraform apply
   ```

All `apply` steps create real, billable AWS resources and are run by a human.

## Validation (no AWS credentials needed)

```bash
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
```
