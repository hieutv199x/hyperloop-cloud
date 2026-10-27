# hyperloop-integrations

GitLab and Jenkins integration adapters for Hyperloop Cloud.

## Setup

```bash
npm install --prefix ../hyperloop-contracts && npm run build --prefix ../hyperloop-contracts
npm install
npm test
npm run build
```

## Scope

- GitLab (M4): allowlists, release-branch push ban, idempotent MR by workflow marker, crash reconcile
- Jenkins: CI callback parsing, stale SHA detection, shared-library post-build hook (later)
- Identity: Jira/GitLab/Entra mapping interfaces (later)

Do not replace existing Jenkins pipelines — only add a small callback hook.

## M4 acceptance

- [x] `InMemoryGitLabClient` for local/tests
- [x] Idempotent `createOrUpdateMr` + `reconcileAfterPush`

