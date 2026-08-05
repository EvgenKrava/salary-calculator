terraform {
  # >= 1.10 is required, not merely preferred: the backend below uses
  # `use_lockfile` (S3-native state locking), which Terraform only understands
  # from 1.10.0. A 1.9.x runner would fail at `terraform init` — and the offline
  # validation step cannot catch it, because `init -backend=false` does not
  # check backend argument names at all.
  required_version = ">= 1.10, < 2.0"

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
