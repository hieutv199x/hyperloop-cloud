# syntax=docker/dockerfile:1.7
# Build from monorepo root:
#   docker build -f hyperloop-control-plane/Dockerfile -t hyperloop/control-plane:local .
ARG NODE_VERSION=22.14.0-bookworm-slim
FROM node:${NODE_VERSION} AS build

WORKDIR /src
COPY hyperloop-contracts ./hyperloop-contracts
COPY hyperloop-integrations ./hyperloop-integrations
COPY hyperloop-control-plane ./hyperloop-control-plane

WORKDIR /src/hyperloop-contracts
RUN npm ci && npm run build

WORKDIR /src/hyperloop-integrations
RUN npm ci && npm run build

WORKDIR /src/hyperloop-control-plane
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}
ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hyperloop-control-plane" \
      org.opencontainers.image.description="Hyperloop Control Plane API + Scheduler (no Kiro)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && command -v kiro >/dev/null 2>&1 && exit 1 || true

WORKDIR /app
COPY --from=build /src/hyperloop-control-plane/package.json ./
COPY --from=build /src/hyperloop-control-plane/node_modules ./node_modules
COPY --from=build /src/hyperloop-control-plane/dist ./dist
COPY --from=build /src/hyperloop-contracts /src/hyperloop-contracts
COPY --from=build /src/hyperloop-integrations /src/hyperloop-integrations

ENV NODE_ENV=production \
    PORT=8080
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# Scheduler Deployment overrides: ["node","dist/index.js","scheduler"]
CMD ["node", "dist/index.js", "api"]
