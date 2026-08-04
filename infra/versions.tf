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
    key            = "infra/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "salary-calculator-tflock"
    encrypt        = true
    # bucket       = "salary-calculator-tfstate-<ACCOUNT_ID>"  <-- set via `terraform init -backend-config="bucket=..."`
  }
}
