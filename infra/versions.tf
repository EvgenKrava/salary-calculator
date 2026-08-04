terraform {
  required_version = "~> 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    # NOTE: backend blocks cannot use variables. Fill these from the bootstrap
    # outputs before `terraform init` (see README). The bucket name embeds the
    # AWS account id.
    key    = "infra/terraform.tfstate"
    region = "us-east-1"

    # S3-native state locking (conditional writes). Replaces the old
    # `dynamodb_table` argument, which Terraform now reports as deprecated and
    # which also hardcoded a `project_name`-derived table name that no variable
    # could keep in sync with the bootstrap.
    use_lockfile = true

    encrypt = true
    # bucket = "salary-calculator-tfstate-<ACCOUNT_ID>"  <-- set via `terraform init -backend-config="bucket=..."`
  }
}
