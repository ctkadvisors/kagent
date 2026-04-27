# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the @kagent/workbench-api image. Mirrors the
# operator Dockerfile shape — Node 22 + pnpm install, then Node 22 +
# tsx runtime. The workbench-api uses @kubernetes/client-node, so the
# same TLS/Bun parity reasoning that pinned the operator to Node 22
# applies here.
#
# Build context = REPO ROOT (so the workspace install can pull the
# @kagent/dto sibling package + any future workspace deps):
#   docker build -t ghcr.io/ctkadvisors/kagent-workbench-api:<tag> \
#     -f packages/workbench-api/Dockerfile .

# ---------------------------------------------------------------------
# Stage 1: install — pnpm-driven workspace install.
# ---------------------------------------------------------------------
FROM node:22-alpine AS install

RUN corepack enable

WORKDIR /repo

# Workspace manifests first so layer cache survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/agent-loop/package.json packages/agent-loop/
COPY packages/openai-compat/package.json packages/openai-compat/
COPY packages/in-process-tool-provider/package.json packages/in-process-tool-provider/
COPY packages/mcp-tool-provider/package.json packages/mcp-tool-provider/
COPY packages/http-tool-provider/package.json packages/http-tool-provider/
COPY packages/trace-sinks/package.json packages/trace-sinks/
COPY packages/operator/package.json packages/operator/
COPY packages/agent-pod/package.json packages/agent-pod/
COPY packages/dto/package.json packages/dto/
COPY packages/workbench-api/package.json packages/workbench-api/
COPY packages/workbench-ui/package.json packages/workbench-ui/

RUN pnpm install --frozen-lockfile --prod=false

# Source after install so node_modules layer survives source edits.
# Only the packages this image actually exercises at runtime.
COPY packages/dto/src packages/dto/src
COPY packages/workbench-api/src packages/workbench-api/src
COPY tsconfig.base.json ./

# ---------------------------------------------------------------------
# Stage 2: runtime — Node 22. tsx executes TypeScript directly.
# Runtime kept on Node (not Bun) for @kubernetes/client-node TLS parity
# against K3s self-signed CAs — same constraint as the operator. See
# packages/operator/Dockerfile for the original rationale.
# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=install --chown=node:node /repo /app

WORKDIR /app/packages/workbench-api

# tsx (devDep) executes TypeScript directly under Node 22.
ENTRYPOINT ["node", "--import", "tsx/esm", "src/main.ts"]
