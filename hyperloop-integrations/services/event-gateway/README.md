# event-gateway

Runtime process for Hyperloop Event Gateway (v1.3 §0.1).

Source: `hyperloop-integrations/src/event-gateway/`.

```bash
# from hyperloop-integrations/
npm run build
PORT=8081 node dist/event-gateway/main.js

# image (from monorepo root)
docker build -f hyperloop-integrations/services/event-gateway/Dockerfile \
  -t hyperloop/event-gateway:local .
```
