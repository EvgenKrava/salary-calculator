# The extraction application code lives in packages/extraction (built separately). This
# file owns only its AWS resources, per docs/contracts/extraction-lambda.md.

locals {
  extraction_bundle = "${path.module}/../packages/extraction/dist/extract.js"
  # Terraform must be able to plan before the extraction package exists, so fall back to a
  # placeholder. A real deploy runs infra/build/build.sh first.
  extraction_source = fileexists(local.extraction_bundle) ? local.extraction_bundle : "${path.module}/build/placeholder.js"
}

data "archive_file" "extraction" {
  type        = "zip"
  source_file = local.extraction_source
  output_path = "${path.module}/.build/extraction.zip"
}

resource "aws_lambda_function" "extraction" {
  function_name = "${var.project_name}-extraction"
  role          = aws_iam_role.extraction.arn
  handler       = "extract.handler"
  runtime       = "nodejs20.x"
  timeout       = 300
  memory_size   = 1024

  filename         = data.archive_file.extraction.output_path
  source_code_hash = data.archive_file.extraction.output_base64sha256

  environment {
    variables = merge(local.db_env, {
      DOCUMENTS_BUCKET         = aws_s3_bucket.documents.id
      AWS_BEARER_TOKEN_BEDROCK = var.bedrock_bearer_token
      BEDROCK_MODEL_ID         = "anthropic.claude-opus-5"
      CONFIDENCE_THRESHOLD     = "0.85"
    })
  }
}

/**
 * No automatic retries on this function.
 *
 * S3 invokes it asynchronously, where AWS retries twice by default — so a single document
 * that fails costs THREE paid Bedrock vision calls (the most expensive thing in the stack),
 * and the handler writes an extraction_jobs row on every attempt.
 *
 * Retries add nothing here: the handler already turns every failure (refusal, throttle,
 * unsupported media, bad key) into a `rejected` queue row explaining itself, and re-uploading
 * the document is the documented recovery path. A genuinely transient Bedrock throttle is
 * cheaper to re-drive by re-uploading than to pay for twice automatically.
 */
resource "aws_lambda_function_event_invoke_config" "extraction" {
  function_name          = aws_lambda_function.extraction.function_name
  maximum_retry_attempts = 0
}

resource "aws_cloudwatch_log_group" "extraction" {
  name              = "/aws/lambda/${aws_lambda_function.extraction.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_permission" "s3_invoke_extraction" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.extraction.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.documents.arn
}

resource "aws_s3_bucket_notification" "documents" {
  bucket = aws_s3_bucket.documents.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.extraction.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/"
  }

  depends_on = [aws_lambda_permission.s3_invoke_extraction]
}
