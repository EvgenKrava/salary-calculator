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
