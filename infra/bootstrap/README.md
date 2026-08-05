# Terraform state bootstrap

One-time setup that creates the S3 state bucket used by the main stack in `../`.
Uses local state (this bootstrap is small and rarely changes).

There is no DynamoDB lock table: the main stack locks state with S3 conditional
writes (`use_lockfile = true`), which Terraform prefers over the deprecated
`dynamodb_table` backend argument.

## Apply (run once, by a human with AWS access)

```bash
cd infra/bootstrap
terraform init
# Pass the SAME project_name/region you will use for the main stack — they are baked
# into resource names here and into the main stack's backend block.
terraform apply -var="project_name=salary-calculator" -var="region=us-east-1"
```

Note the `state_bucket` output — it must match the `backend
"s3"` block in `../versions.tf`. The bucket name embeds the AWS account id, so it
is stable per account.
