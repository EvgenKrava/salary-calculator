# Terraform state bootstrap

One-time setup that creates the S3 state bucket and DynamoDB lock table used by
the main stack in `../`. Uses local state (this bootstrap is small and rarely
changes).

## Apply (run once, by a human with AWS access)

```bash
cd infra/bootstrap
terraform init
terraform apply   # uses the "yevhenii" AWS profile
```

Note the `state_bucket` output — it must match the `backend
"s3"` block in `../versions.tf`. The bucket name embeds the AWS account id, so it
is stable per account.
