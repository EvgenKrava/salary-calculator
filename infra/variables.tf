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
    Aurora PostgreSQL version. Prefer a MAJOR-only value (e.g. "15") so AWS picks the
    current default minor — pinning a specific minor breaks once AWS retires it, and
    fights auto minor upgrades. Must be a version that supports Serverless v2 and the
    RDS Data API (PostgreSQL 13.6+ for Serverless v2; the Data API needs a current
    minor, so major-only pinning is the safe choice).
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
}
