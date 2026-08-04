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

variable "db_min_acu" {
  description = "Aurora Serverless v2 minimum capacity units."
  type        = number
  default     = 0.5
}

variable "db_max_acu" {
  description = "Aurora Serverless v2 maximum capacity units."
  type        = number
  default     = 2
}
