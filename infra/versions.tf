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

    # The backend does NOT inherit the provider's `profile`, and it does not read
    # var.aws_profile — it has its own credential resolution. Without this line it falls
    # back to the default chain, which on this machine is an SSO role in a DIFFERENT
    # account (039885961427), producing a confusing 403 on HeadObject against a state
    # bucket that the `yevhenii` profile can read perfectly well.
    #
    # Hardcoded rather than parameterised because backends cannot use variables. If the
    # profile name ever changes, override at init time:
    #   terraform init -reconfigure -backend-config="profile=<name>"
    profile = "yevhenii"

    # S3-native state locking (conditional writes). Replaces the old
    # `dynamodb_table` argument, which Terraform now reports as deprecated and
    # which also hardcoded a `project_name`-derived table name that no variable
    # could keep in sync with the bootstrap.
    use_lockfile = true

    encrypt = true
    # bucket = "salary-calculator-tfstate-<ACCOUNT_ID>"  <-- set via `terraform init -backend-config="bucket=..."`
  }
}
