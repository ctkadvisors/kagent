# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for @kagent/tool-gateway. Stage 1 installs the
# pnpm workspace and compiles the gateway plus transitive workspace
# deps. Stage 2 ships a node:22-alpine runtime with the SSH client needed
# by shell.exec, then runs `node dist/main.js`.
#
# Build context = REPO ROOT:
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-tool-gateway:<tag> \
#     -f packages/tool-gateway/Dockerfile \
#     --platform linux/amd64,linux/arm64 .

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/agent-loop/package.json packages/agent-loop/
COPY packages/dto/package.json packages/dto/
COPY packages/http-tool-provider/package.json packages/http-tool-provider/
COPY packages/mcp-tool-provider/package.json packages/mcp-tool-provider/
COPY packages/tool-gateway/package.json packages/tool-gateway/

RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/agent-loop packages/agent-loop
COPY packages/dto packages/dto
COPY packages/http-tool-provider packages/http-tool-provider
COPY packages/mcp-tool-provider packages/mcp-tool-provider
COPY packages/tool-gateway packages/tool-gateway

RUN pnpm --filter @kagent/tool-gateway... build
RUN node scripts/rewrite-exports-to-dist.mjs
RUN node -e "require('fs').accessSync('packages/tool-gateway/dist/main.js')"
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime

RUN apk add --no-cache openssh-client

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/tool-gateway

EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]
