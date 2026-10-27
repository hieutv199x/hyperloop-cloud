# Base image will be replaced with private Nexus Node image in M2.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY dist ./dist
COPY entrypoint/run-agent.sh /entrypoint/run-agent.sh
RUN chmod +x /entrypoint/run-agent.sh

# Kiro CLI installation is environment-specific and added in M2.
USER node
ENTRYPOINT ["/entrypoint/run-agent.sh"]
