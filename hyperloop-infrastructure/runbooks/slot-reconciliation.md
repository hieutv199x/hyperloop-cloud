# Runbook: admission slot reconciliation

## Symptom

`hyperloop_slots_used` stuck near 100 while few Agent Jobs are actually running, or queued work never dispatches.

## Checks

1. Read `GET /scheduler/capacity` and compare with DynamoDB `CAPACITY#GLOBAL`.
2. List `RESERVATION#*` items with `state=ACTIVE`.
3. For each reservation, query Kubernetes Job by deterministic name.
4. If Job is terminal or NotFound **and** desired ownership is confirmed, run the release transaction once.
5. Never decrement capacity based solely on lost scheduler heartbeat.
