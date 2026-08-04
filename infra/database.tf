resource "random_password" "db" {
  length  = 24
  special = false
}

locals {
  # Referenced by both the cluster and the Secrets Manager payload — keep it in one place
  # so the two can never drift (a mismatch would apply cleanly but silently break every
  # Data API client that reads its credentials from the secret).
  db_master_username = "salary_admin"
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.project_name}-db-credentials"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = local.db_master_username
    password = random_password.db.result
  })
}

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "${var.project_name}-db"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = "15.4"
  database_name          = var.db_name
  master_username        = local.db_master_username
  master_password        = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  # This cluster holds payroll and personal data. The AWS provider defaults
  # storage_encrypted to false, so encryption at rest must be set explicitly — and it
  # cannot be enabled in place later without recreating the cluster from a snapshot.
  storage_encrypted = true

  # RDS Data API — how the Lambdas reach the DB without being in the VPC.
  enable_http_endpoint = true

  serverlessv2_scaling_configuration {
    min_capacity = var.db_min_acu
    max_capacity = var.db_max_acu
  }

  # Dev-friendly lifecycle. Revisit for production (final snapshot, deletion protection).
  skip_final_snapshot = true

  lifecycle {
    ignore_changes = [master_password]
  }
}

resource "aws_rds_cluster_instance" "main" {
  identifier         = "${var.project_name}-db-1"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
}
