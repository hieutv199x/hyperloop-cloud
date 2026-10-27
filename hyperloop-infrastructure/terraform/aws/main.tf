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

# Scaffold resources — expand in M1.5 / M7.
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

locals {
  queues = ["planner", "coding", "fix"]
}

resource "aws_sqs_queue" "agent_dlq" {
  for_each = toset(local.queues)
  name     = "hyperloop-${each.key}-dlq-${var.environment}"
}

resource "aws_sqs_queue" "agent" {
  for_each = toset(local.queues)
  name     = "hyperloop-${each.key}-queue-${var.environment}"

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.agent_dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.hyperloop_workflows.name
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "sqs_queue_urls" {
  value = { for k, q in aws_sqs_queue.agent : k => q.url }
}

output "global_max_concurrent_jobs" {
  value = var.global_max_concurrent_jobs
}
