data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

# Two private subnets in two AZs (Aurora requires a subnet group spanning >= 2 AZs).
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${var.project_name}-private-${count.index}" }
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${var.project_name}-db" }
}

# Security group for the Aurora cluster. Ingress is self-referential (only
# resources in this SG can reach 5432). The Data API does not connect through
# this SG, but the SG is still required on the cluster.
resource "aws_security_group" "db" {
  name        = "${var.project_name}-db"
  description = "Aurora cluster access"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_self" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.db.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "db_all" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
