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

  statement {
    sid = "InvokeClaudeOnBedrock"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    # Scoped to Anthropic models rather than "*": the extraction Lambda has no reason to
    # invoke any other provider's models, and a narrower policy limits the blast radius if
    # the function is ever compromised.
    resources = ["arn:aws:bedrock:${var.region}::foundation-model/anthropic.*"]
  }
}

resource "aws_iam_role_policy" "extraction_extra" {
  role   = aws_iam_role.extraction.id
  policy = data.aws_iam_policy_document.extraction_extra.json
}
