locals {
  # Shared Data API wiring. Every Lambda reads the DB this way, so none is VPC-attached.
  # Bedrock may live in a different AWS account/region than this stack; empty means "same
  # region as the app". The bearer token carries its own identity, so the account boundary
  # needs no IAM wiring — only the correct endpoint region.
  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : var.region

  db_env = {
    AWS_REGION_NAME = var.region # AWS_REGION is reserved by the Lambda runtime
    DB_RESOURCE_ARN = aws_rds_cluster.main.arn
    DB_SECRET_ARN   = aws_secretsmanager_secret.db.arn
    DB_NAME         = var.db_name
  }
}

# Both zips ship a SINGLE self-contained file, which only works because `pnpm --filter
# @salary/api bundle` inlines everything the handler needs — including the migration SQL,
# via packages/core/src/migrations.generated.ts. Nothing is read from disk at runtime.
#
# If a handler ever needs a real sibling file, switch to `source_dir` here AND drop the
# runtime filesystem read; do not add `source_file` entries one at a time. The migration
# Lambda previously shipped as a lone .js that tried to `readFileSync` its .sql files, which
# were not in the zip — it failed at cold start, after a clean `terraform apply`.
# Guarded by packages/api/test/bundle.test.ts.
#
# Note the zips are NOT reproducible across machines (archive_file stores mtimes), so a
# rebuild can show a Lambda update in the plan even with identical source.
data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../packages/api/dist/api.js"
  output_path = "${path.module}/.build/api.zip"
}

data "archive_file" "migrate" {
  type        = "zip"
  source_file = "${path.module}/../packages/api/dist/migrate.js"
  output_path = "${path.module}/.build/migrate.zip"
}

resource "aws_lambda_function" "api" {
  function_name = "${var.project_name}-api"
  role          = aws_iam_role.api.arn
  handler       = "api.handler"
  runtime       = "nodejs20.x"

  # Sized for the schedule import, the heaviest request by far. Parsing the real 1.25 MB
  # workbook with exceljs peaked at 299 MB and blew the previous 30 s timeout — API Gateway
  # surfaced that to the manager as a bare "503 Service Unavailable", with nothing in the
  # Lambda log but `Status: timeout`.
  #
  # Lambda scales CPU with memory, so 1536 MB also makes the parse several times faster
  # rather than merely fitting. Cost impact is nil: per-request billing on a handful of
  # imports a month, idle otherwise.
  timeout     = 120
  memory_size = 1536

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  environment {
    variables = merge(local.db_env, {
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      # Lets the API presign uploads of photographed revenue sheets, so the browser PUTs
      # straight to S3 and the ObjectCreated event triggers AI extraction. Without it the
      # upload route returns 503 by design rather than failing on an undefined bucket.
      DOCUMENTS_BUCKET = aws_s3_bucket.documents.id
    })
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "migrate" {
  function_name = "${var.project_name}-migrate"
  role          = aws_iam_role.migrate.arn
  handler       = "migrate.handler"
  runtime       = "nodejs20.x"
  # Applying the whole schema takes longer than an API request; Aurora Serverless v2 may
  # also be resuming from zero capacity on the first call.
  timeout     = 300
  memory_size = 512

  filename         = data.archive_file.migrate.output_path
  source_code_hash = data.archive_file.migrate.output_base64sha256

  environment {
    variables = local.db_env
  }
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/aws/lambda/${aws_lambda_function.migrate.function_name}"
  retention_in_days = var.log_retention_days
}
