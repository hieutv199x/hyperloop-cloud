terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "global_max_concurrent_jobs" {
  type    = number
  default = 100
}

locals {
  # Section 0.4 queues (+ DLQs). Agent ready queues + ingress event queues.
  agent_queues = ["planner", "coding", "fix"]
  event_queues = ["devspec-events", "ci-events", "mr-events"]
  all_queues   = concat(local.agent_queues, local.event_queues)
}

resource "aws_dynamodb_table" "hyperloop_workflows" {
  name         = "hyperloop-workflows-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # QUEUED job intents by readiness / priority for scheduler scans
  global_secondary_index {
    name            = "gsi1-queued-intents"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # Workflow / execution lookups by external correlation (MR, SHA, project)
  global_secondary_index {
    name            = "gsi2-correlation"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Project     = "hyperloop"
    Environment = var.environment
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "hyperloop-artifacts-${var.environment}"

  tags = {
    Project     = "hyperloop"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each = toset(local.all_queues)
  name     = "hyperloop-${each.key}-dlq-${var.environment}"

  tags = {
    Project     = "hyperloop"
    Environment = var.environment
  }
}

resource "aws_sqs_queue" "queue" {
  for_each = toset(local.all_queues)
  name     = "hyperloop-${each.key}-queue-${var.environment}"

  # Ready-work messages must not stay invisible for hours while waiting for a slot.
  visibility_timeout_seconds = 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })

  tags = {
    Project     = "hyperloop"
    Environment = var.environment
  }
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.hyperloop_workflows.name
}

output "dynamodb_gsi_queued_intents" {
  value = "gsi1-queued-intents"
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "sqs_queue_urls" {
  value = { for k, q in aws_sqs_queue.queue : k => q.url }
}

output "sqs_devspec_events_url" {
  value = aws_sqs_queue.queue["devspec-events"].url
}

output "global_max_concurrent_jobs" {
  value = var.global_max_concurrent_jobs
}
