#!/usr/bin/env bash
set -euo pipefail
awslocal s3 mb s3://hyperloop-artifacts-dev || true
for q in planner coding fix devspec-events ci-events mr-events; do
  awslocal sqs create-queue --queue-name "hyperloop-${q}-queue-dev" || true
done
echo "localstack init ok"
