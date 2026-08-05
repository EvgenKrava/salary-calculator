resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"

  # The SPA is served from CloudFront on a different origin than the API, so browsers
  # preflight every non-GET request.
  cors_configuration {
    allow_origins  = ["https://${aws_cloudfront_distribution.frontend.domain_name}"]
    allow_methods  = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers  = ["authorization", "content-type"]
    expose_headers = ["content-type"]
    max_age        = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-cognito"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spa.id]
    issuer   = "https://${aws_cognito_user_pool.main.endpoint}"
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# One catch-all route. The Hono app inside the Lambda does its own routing, and its
# authMiddleware re-verifies the token — the gateway authorizer is defence in depth, not
# the only check.
resource "aws_apigatewayv2_route" "any" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "ANY /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

/**
 * CORS preflight must be UNAUTHENTICATED.
 *
 * Browsers send `OPTIONS` with no `Authorization` header — that is the spec, not a bug — so a
 * preflight against the JWT-authorized catch-all returns 401 and the browser reports a bare
 * "NetworkError when attempting to fetch resource", never showing the real status. Every
 * non-GET call from the SPA failed this way: the app looked completely broken while the API
 * was healthy.
 *
 * `httpMethod = OPTIONS` is more specific than `ANY`, so API Gateway matches it first. It
 * returns only the CORS headers from `cors_configuration`; the Lambda is never invoked, so
 * there is nothing to protect here.
 */
resource "aws_apigatewayv2_route" "options_preflight" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "OPTIONS /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

# /health must be reachable unauthenticated — it is the deploy smoke test.
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /health"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      httpMethod       = "$context.httpMethod"
      path             = "$context.path"
      status           = "$context.status"
      responseLatency  = "$context.responseLatency"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${var.project_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_permission" "apigw_invoke_api" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
