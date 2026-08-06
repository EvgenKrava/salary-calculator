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

/**
 * User management: the API creates a Cognito login when a manager invites an employee, and
 * disables it when the employee is deactivated.
 *
 * Unlike the Bedrock case, this IS a real boundary — these calls are SigV4-signed with the
 * Lambda's execution role, so the resource restriction below actually applies.
 *
 * Scoped to this one user pool, and to only the actions employee onboarding needs. Notably
 * absent: AdminSetUserPassword and AdminInitiateAuth (no impersonating a user or setting their
 * password), AdminUpdateUserAttributes (no changing someone's email out from under them), and
 * ListUsers (the employee table is the app's directory; the API never needs to enumerate the
 * pool).
 *
 * AdminDeleteUser is present ONLY to roll back a failed invite — a deactivated employee is
 * disabled, never deleted, so their salary history survives.
 */
data "aws_iam_policy_document" "api_user_management" {
  statement {
    sid = "ManageEmployeeLogins"
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDeleteUser",
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "api_user_management" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_user_management.json
}

/**
 * Presigning an upload requires the signer to hold s3:PutObject itself — a presigned URL can
 * only ever grant a subset of the signer's own permissions.
 *
 * Scoped to the `uploads/` prefix, not the whole bucket: that is the only place the extraction
 * trigger watches, and it keeps the API from being able to overwrite anything else the bucket
 * comes to hold. No GetObject or Delete — the API never reads or removes a document; the
 * extraction Lambda reads, and documents are payroll evidence that should not be silently
 * deletable.
 */
data "aws_iam_policy_document" "api_uploads" {
  statement {
    sid       = "PresignDocumentUploads"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/uploads/*"]
  }
}

resource "aws_iam_role_policy" "api_uploads" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_uploads.json
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

  # There is deliberately NO bedrock:* statement here.
  #
  # Bedrock is consumed CROSS-ACCOUNT: the bearer token belongs to a principal in a different
  # AWS account (see `bedrock_bearer_token` in variables.tf), and a bearer token is authorized
  # against the principal that created it — not against this execution role, and not against
  # this account. Verified by calling the endpoint directly with the token and getting HTTP 200.
  #
  # A `bedrock:InvokeModel` grant scoped to `arn:aws:bedrock:<region>::foundation-model/...`
  # was removed because it named foundation models in THIS account, which the Lambda never
  # invokes. It granted nothing, denied nothing, and read as a least-privilege boundary that
  # did not exist — the worst property a policy can have.
  #
  # The real control is the permissions of the token-generating principal in the Bedrock
  # account. See infra/cost.md and the note on rotation in infra/README.md. If the handler ever
  # switches to SigV4 against `bedrock-runtime` in this account, a grant has to be added back.
}

resource "aws_iam_role_policy" "extraction_extra" {
  role   = aws_iam_role.extraction.id
  policy = data.aws_iam_policy_document.extraction_extra.json
}
