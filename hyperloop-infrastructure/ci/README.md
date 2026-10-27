# CI notes

Build and push images to private Nexus. Do not publish agent images to public registries.

Suggested pipeline stages per service repo:

1. `npm ci && npm test && npm run build`
2. Build image, scan, push digest
3. Deploy Helm chart to target environment
