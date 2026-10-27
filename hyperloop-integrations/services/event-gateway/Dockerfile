# syntax=docker/dockerfile:1.7
# Build from monorepo root:
#   docker build -f hyperloop-integrations/services/event-gateway/Dockerfile \
#     -t hyperloop/event-gateway:local .
ARG NODE_VERSION=22.14.0-bookworm-slim
FROM node:${NODE_VERSION} AS build

WORKDIR /src
COPY hyperloop-contracts ./hyperloop-contracts
COPY hyperloop-integrations ./hyperloop-integrations

WORKDIR /src/hyperloop-contracts
RUN npm ci && npm run build

WORKDIR /src/hyperloop-integrations
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}
ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hyperloop-event-gateway" \
      org.opencontainers.image.description="Hyperloop Event Gateway — webhooks only, no Kiro" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/hyperloop-integrations/package.json ./
COPY --from=build /src/hyperloop-integrations/node_modules ./node_modules
COPY --from=build /src/hyperloop-integrations/dist ./dist
COPY --from=build /src/hyperloop-contracts /src/hyperloop-contracts

ENV NODE_ENV=production \
    PORT=8081
USER node
EXPOSE 8081
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/event-gateway/main.js"]
