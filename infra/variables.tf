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
  description = "Aurora Serverless v2 minimum capacity units."
  type        = number
  default     = 0.5

  validation {
    # RDS rejects out-of-range or non-0.5-multiple values with an opaque error at apply
    # time; catch it at plan time instead.
    condition     = var.db_min_acu >= 0 && var.db_min_acu <= 256 && var.db_min_acu % 0.5 == 0
    error_message = "db_min_acu must be between 0 and 256 and a multiple of 0.5."
  }
}

variable "db_max_acu" {
  description = "Aurora Serverless v2 maximum capacity units."
  type        = number
  default     = 2

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
