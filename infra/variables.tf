variable "project_name" {
  type    = string
  default = "salary-calculator"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "yevhenii"
}

variable "db_name" {
  type    = string
  default = "salary"
}

variable "db_engine_version" {
  description = <<-EOT
    Aurora PostgreSQL version. Prefer a MAJOR-only value (e.g. "15"): the AWS provider
    prefix-matches, so AWS resolves the current default minor. Two concrete reasons this
    beats pinning a minor: AWS retires minors (the previously pinned "15.4" no longer
    exists — the lowest available 15.x is now 15.10), and a pinned minor fights
    auto_minor_version_upgrade, producing a perpetual "downgrade" diff that RDS refuses.
    Serverless v2 requires PostgreSQL 13.6+. Confirm Data API support for the resolved
    version with the smoke test in README.md step 4 rather than assuming it.
  EOT
  type        = string
  default     = "15"
}

variable "db_min_acu" {
  description = <<-EOT
    Aurora Serverless v2 minimum capacity units. Default 0 enables scale-to-zero: the
    cluster pauses after db_seconds_until_auto_pause with no connections and bills no ACUs
    while idle. This is the difference between ~$0/month and ~$44/month for a tool used a
    few times a month, so do NOT raise it to 0.5 without a reason — see the cost note in
    database.tf. Cost of the default: ~15 s cold resume on the first request after idle.
  EOT
  type        = number
  default     = 0

  validation {
    # RDS rejects out-of-range or non-0.5-multiple values with an opaque error at apply
    # time; catch it at plan time instead.
    condition     = var.db_min_acu >= 0 && var.db_min_acu <= 256 && var.db_min_acu % 0.5 == 0
    error_message = "db_min_acu must be between 0 and 256 and a multiple of 0.5."
  }
}

variable "db_max_acu" {
  description = <<-EOT
    Aurora Serverless v2 maximum capacity units. This is a CEILING on the worst-case bill:
    at $0.12/ACU-hour, a runaway query pinned at max for a full month costs
    max_acu x 730 x $0.12. Kept at 1 so that worst case is ~$88 rather than the ~$175 that
    2 ACUs would allow; a salary run over a few hundred rows does not need more.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.db_max_acu >= 0.5 && var.db_max_acu <= 256 && var.db_max_acu % 0.5 == 0
    error_message = "db_max_acu must be between 0.5 and 256 and a multiple of 0.5."
  }

  validation {
    # An inverted range is otherwise only caught by an opaque RDS error at apply time.
    condition     = var.db_max_acu >= var.db_min_acu
    error_message = "db_max_acu must be greater than or equal to db_min_acu."
  }
}

variable "monthly_budget_usd" {
  description = <<-EOT
    Monthly spend target in USD, used for the AWS Budgets alarm. NOTE: AWS Budgets notifies,
    it does not cap — there is no hard spend limit available. See cost.md for the estimate
    this figure is based on.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be greater than 0."
  }
}

variable "budget_alert_emails" {
  description = <<-EOT
    Email addresses to notify when spend crosses a budget threshold. Set this in
    terraform.tfvars — an empty list means the budget is created but NOBODY is told when it
    is breached, which defeats the point.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.budget_alert_emails) > 0
    error_message = "budget_alert_emails must contain at least one address, or a cost overrun would go unnoticed. Set it in terraform.tfvars."
  }
}

variable "cloudfront_price_class" {
  description = <<-EOT
    CloudFront edge coverage. PriceClass_100 (North America + Europe) is the cheapest and
    covers Ukraine, where all users are. The provider default is PriceClass_All, which adds
    the most expensive regions for no benefit here.
  EOT
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "db_seconds_until_auto_pause" {
  description = <<-EOT
    Idle seconds before a min_capacity = 0 cluster pauses to zero ACUs. Only has an effect
    when db_min_acu is 0. Lower pauses sooner (cheaper, more cold resumes); AWS allows
    300–86400. 300 is deliberate: this app is used in short bursts a few times a month, so
    pausing as early as possible is what keeps the bill near zero.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.db_seconds_until_auto_pause >= 300 && var.db_seconds_until_auto_pause <= 86400
    error_message = "db_seconds_until_auto_pause must be between 300 and 86400 seconds."
  }
}

variable "bedrock_model_id" {
  description = <<-EOT
    Bedrock model id for extraction. Bedrock ids carry the `anthropic.` prefix; the bare id
    returns a 400. A variable rather than a literal so a model can be rolled back without a
    code change.
  EOT
  type        = string
  default     = "anthropic.claude-opus-5"

  validation {
    condition     = startswith(var.bedrock_model_id, "anthropic.")
    error_message = "bedrock_model_id must start with 'anthropic.' — Bedrock rejects the bare model id with a 400."
  }
}

variable "confidence_threshold" {
  description = <<-EOT
    Extractions at or above this confidence are staged as approved; below it they go to the
    manager's review queue. Must be in (0, 1] — the extraction Lambda throws at cold start on
    anything else, because a 0 would silently auto-approve every document and switch off human
    review entirely.
  EOT
  type        = number
  default     = 0.85

  validation {
    condition     = var.confidence_threshold > 0 && var.confidence_threshold <= 1
    error_message = "confidence_threshold must be greater than 0 and at most 1."
  }
}

variable "bedrock_region" {
  description = <<-EOT
    Region whose Bedrock endpoint the extraction Lambda calls. Empty means "same as
    var.region".

    This is separate from var.region because Bedrock can live in a DIFFERENT AWS ACCOUNT
    from the rest of the stack: the bearer token carries its own identity, so the Lambda's
    account and role are irrelevant to the Bedrock call. If that account serves Claude from
    another region, set it here — otherwise the Lambda would call its own region's endpoint
    and fail with a model-not-found or auth error that looks nothing like a region mismatch.
  EOT
  type        = string
  default     = ""
}

variable "bedrock_bearer_token" {
  description = <<-EOT
    Bedrock API key (long-lived bearer token) for the extraction Lambda, which reads it as
    AWS_BEARER_TOKEN_BEDROCK.

    Supply it from your LOCAL ENVIRONMENT, not from a file:

        export TF_VAR_bedrock_bearer_token="$AWS_BEARER_TOKEN_BEDROCK"
        terraform apply

    `./infra/deploy.sh` does that mapping for you. The token is already exported as
    AWS_BEARER_TOKEN_BEDROCK for local development (the Anthropic SDK reads that name
    directly), so this reuses the one copy you already have rather than duplicating a
    long-lived credential into terraform.tfvars, where it would sit in plaintext on disk and
    be one `git add -f` away from the repo.

    Terraform picks up any TF_VAR_-prefixed environment variable automatically; nothing else
    is needed. Marked sensitive so it is redacted from plan/apply output — note it is still
    stored in plaintext in the S3 state (encrypted at rest, versioned) and is visible in the
    Lambda's configuration to anyone with lambda:GetFunctionConfiguration.
  EOT
  type        = string
  sensitive   = true
  default     = ""

  validation {
    # Catch the empty default at plan time. Deploying without the token yields an extraction
    # Lambda that provisions fine and then fails every Bedrock call with an auth error at
    # runtime — a failure that only shows up in CloudWatch after someone uploads a document.
    condition     = length(var.bedrock_bearer_token) > 0
    error_message = "bedrock_bearer_token is empty. Run: export TF_VAR_bedrock_bearer_token=\"$AWS_BEARER_TOKEN_BEDROCK\" (or use ./infra/deploy.sh)."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the Lambdas. 0 keeps logs forever."
  type        = number
  default     = 14
}
