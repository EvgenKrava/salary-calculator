data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Shared: every Lambda needs its own log group and Data API access to the one cluster.
data "aws_iam_policy_document" "data_api" {
  statement {
    sid = "DataApi"
    actions = [
      "rds-data:ExecuteStatement",
      "rds-data:BatchExecuteStatement",
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:RollbackTransaction",
    ]
    resources = [aws_rds_cluster.main.arn]
  }

  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.project_name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "api_data_api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.data_api.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role" "migrate" {
  name               = "${var.project_name}-migrate"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "migrate_data_api" {
  role   = aws_iam_role.migrate.id
  policy = data.aws_iam_policy_document.data_api.json
}

resource "aws_iam_role_policy_attachment" "migrate_logs" {
  role       = aws_iam_role.migrate.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role" "extraction" {
  name               = "${var.project_name}-extraction"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "extraction_data_api" {
  role   = aws_iam_role.extraction.id
  policy = data.aws_iam_policy_document.data_api.json
}

resource "aws_iam_role_policy_attachment" "extraction_logs" {
  role       = aws_iam_role.extraction.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# The extraction Lambda additionally reads the uploaded document and calls Bedrock.
data "aws_iam_policy_document" "extraction_extra" {
  statement {
    sid       = "ReadUploadedDocuments"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }

  # NOTE: this statement is defence-in-depth, NOT the operative control for how the extraction
  # Lambda actually calls Claude today.
  #
  # `AnthropicBedrockMantle` authenticates with the `AWS_BEARER_TOKEN_BEDROCK` API key. A bearer
  # token carries its own identity, so authorization is evaluated against the principal that
  # *generated the key* (`aws bedrock create-api-key`, run by a human per infra/README.md) —
  # this execution role is not consulted on that path. Removing this statement would therefore
  # not reduce what the Lambda can invoke, and keeping it does not restrict the token to
  # Anthropic models.
  #
  # It is kept deliberately: it costs nothing, and it becomes the real control if the handler
  # ever moves to SigV4 (the `bedrock-runtime` InvokeModel API), which is the failure mode where
  # a missing grant is a confusing runtime 403 rather than an obvious one.
  #
  # If a genuine `anthropic.*` boundary is wanted, scope the permissions of the IAM identity
  # used to create the API key. An execution-role policy cannot enforce it. Blast radius if the
  # token leaks (it is a long-lived credential in a Lambda env var) is bounded by that
  # principal's Bedrock permissions, not by the scoping below.
  statement {
    sid = "InvokeClaudeOnBedrock"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = ["arn:aws:bedrock:${var.region}::foundation-model/anthropic.*"]
  }
}

resource "aws_iam_role_policy" "extraction_extra" {
  role   = aws_iam_role.extraction.id
  policy = data.aws_iam_policy_document.extraction_extra.json
}
