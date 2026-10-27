# syntax=docker/dockerfile:1.7
# Build from monorepo root:
#   docker build -f hyperloop-teams-gateway/Dockerfile -t hyperloop/teams-gateway:local .
ARG NODE_VERSION=22.14.0-bookworm-slim
FROM node:${NODE_VERSION} AS build

WORKDIR /src
COPY hyperloop-contracts ./hyperloop-contracts
COPY hyperloop-teams-gateway ./hyperloop-teams-gateway

WORKDIR /src/hyperloop-contracts
RUN npm ci && npm run build

WORKDIR /src/hyperloop-teams-gateway
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}
ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hyperloop-teams-gateway" \
      org.opencontainers.image.description="Hyperloop Teams Gateway — approvals only, no Kiro" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/hyperloop-teams-gateway/package.json ./
COPY --from=build /src/hyperloop-teams-gateway/node_modules ./node_modules
COPY --from=build /src/hyperloop-teams-gateway/dist ./dist
COPY --from=build /src/hyperloop-contracts /src/hyperloop-contracts

ENV NODE_ENV=production \
    PORT=8090
USER node
EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
