output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

// No lock_table output: state locking is S3-native (`use_lockfile = true`), so there is
// no DynamoDB table to reference from the main stack's backend.