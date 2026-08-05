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

  # Dev stage: the secret name is deterministic and skip_final_snapshot implies
  # destroy/re-apply is normal, but Secrets Manager's default 30-day recovery window
  # would block re-creating a secret with the same name for a month. Restore the
  # default window (or remove this line) for production.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = local.db_master_username
    password = random_password.db.result
  })
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = "${var.project_name}-db"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"

  # Major-version pin only. The provider prefix-matches, so AWS selects the current
  # default minor: this avoids hardcoding a minor that AWS later retires (15.4 was
  # already gone — the lowest available 15.x is now 15.10), and avoids the perpetual
  # "downgrade" diff that appears when auto minor upgrades move the actual version
  # past a pinned literal.
  engine_version = var.db_engine_version

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

  # engine_version is deliberately NOT set here: the instance inherits it from the
  # cluster, and duplicating it doubles the surface for version-drift diffs.
}
