# hyperloop-infrastructure

Terraform, Helm, and Kubernetes manifests for Hyperloop Cloud.

## Layout

- `terraform/aws` — DynamoDB (+ GSIs), S3, SQS (`devspec-events`, `planner`/`coding`/`fix`-ready, CI/MR events + DLQs)
- `helm/event-gateway` — Event Gateway Deployment (2 replicas)
- `helm/control-plane` — `control-plane-api` + `control-plane-scheduler` Deployments (one image)
- `helm/teams-gateway` — Teams Gateway Deployment (2 replicas)
- `helm/agent-job` — image digest allowlist ConfigMap + agent ServiceAccounts (**no Deployment**)
- `k8s/namespaces` — `hyperloop-system`, `hyperloop-agents`
- `k8s/rbac` — scheduler Job RBAC; agents have no Job-create rights
- `k8s/network-policies` — agent egress allowlist (deny kube API)
- `k8s/karpenter` — dedicated agent NodePool with taints
- `ci` — build/push to private Nexus, deploy pipelines
- `runbooks` — operational procedures

## Topology (Section 0.4)

| Workload | Namespace | Kind | Replicas |
|---|---|---|---|
| event-gateway | hyperloop-system | Deployment | 2 |
| control-plane-api | hyperloop-system | Deployment | 2 |
| control-plane-scheduler | hyperloop-system | Deployment | 2 |
| teams-gateway | hyperloop-system | Deployment | 2 |
| planner/coding/fix | hyperloop-agents | Job (ephemeral) | on demand |

Only `control-plane-scheduler` may `create/get/list/watch/delete` `batch/jobs` in `hyperloop-agents`.

## Non-negotiables

- Global admission is enforced in DynamoDB (100 slots), not by counting Running pods.
- Agent ServiceAccounts must not create Jobs or mutate global quota.
- Pin images by digest from private Nexus.
- Separate configs for `dev` / `staging` / `prod`.

## Local validation

```bash
helm lint helm/event-gateway helm/control-plane helm/teams-gateway helm/agent-job

helm template eg helm/event-gateway \
  | cat - <(helm template cp helm/control-plane) \
         <(helm template tg helm/teams-gateway) \
         <(helm template aj helm/agent-job) \
  | tee /tmp/hyperloop-render.yaml \
  | kubeconform -strict -ignore-missing-schemas

# Exactly four Deployments
yq 'select(.kind == "Deployment") | .metadata.name' /tmp/hyperloop-render.yaml

# agent-job chart must not emit Deployments
helm template aj helm/agent-job | yq 'select(.kind == "Deployment")'   # empty

terraform -chdir=terraform/aws init -backend=false
terraform -chdir=terraform/aws validate
```
