output "db_cluster_arn" {
  description = "Aurora cluster ARN (for the RDS Data API)."
  value       = aws_rds_cluster.main.arn
}

output "db_secret_arn" {
  description = "Secrets Manager ARN holding the DB credentials."
  value       = aws_secretsmanager_secret.db.arn
}

output "db_name" {
  value = var.db_name
}

output "api_url" {
  description = "Base URL of the HTTP API."
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "frontend_url" {
  description = "CloudFront URL serving the SPA."
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "frontend_bucket" {
  description = "S3 bucket the built SPA is synced to."
  value       = aws_s3_bucket.frontend.id
}

output "documents_bucket" {
  description = "S3 bucket for uploaded revenue reports and schedules."
  value       = aws_s3_bucket.documents.id
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.spa.id
}

output "cloudfront_distribution_id" {
  description = "Needed to invalidate the CDN cache after a frontend deploy."
  value       = aws_cloudfront_distribution.frontend.id
}

output "migrate_function_name" {
  description = "Invoke this once after the first apply to create the schema."
  value       = aws_lambda_function.migrate.function_name
}
