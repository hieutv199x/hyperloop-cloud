# hyperloop-infrastructure

Terraform, Helm, and Kubernetes manifests for Hyperloop Cloud.

## Layout

- `terraform/aws` — DynamoDB, S3, SQS (+ DLQs), IAM / Pod Identity, monitoring
- `helm/control-plane` — Control Plane deployment
- `helm/agent-job` — Job template used by controller (not always-on)
- `helm/teams-gateway` — Teams Gateway deployment
- `k8s/namespaces` — `hyperloop-system`, `hyperloop-agents`
- `k8s/rbac` — least-privilege RBAC
- `k8s/network-policies` — agent egress restrictions
- `k8s/karpenter` — dedicated agent node pool
- `ci` — build/push to private Nexus, deploy pipelines
- `runbooks` — operational procedures

## Non-negotiables

- Global admission is enforced in DynamoDB (100 slots), not by counting Running pods.
- Agent ServiceAccounts must not create Jobs or mutate global quota.
- Pin images by digest from private Nexus.
- Separate configs for `dev` / `staging` / `prod`.

## Local validation

```bash
# when Terraform/Helm are installed
terraform -chdir=terraform/aws fmt -check
helm lint helm/control-plane
```
