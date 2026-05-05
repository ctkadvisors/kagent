# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for @kagent/llm-gateway. Stage 1 installs the
# pnpm workspace and compiles the package + its transitive workspace
# deps. Stage 2 ships a node:22-alpine-only runtime that runs
# `node dist/main.js`.
#
# Build context = REPO ROOT so the workspace install pulls every
# sibling package the gateway transitively depends on. From the
# repo root:
#
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-llm-gateway:<tag> \
#     -f packages/llm-gateway/Dockerfile \
#     --platform linux/amd64,linux/arm64 .
#
# Image expects DATABASE_URL + ADMIN_API_TOKEN at runtime; see
# packages/llm-gateway/src/env.ts for the full env contract.

# ---------------------------------------------------------------------
# Stage 1: build — pnpm install (full devDeps), tsc emit, exports
# rewrite, then a final prod-only `pnpm install` to drop dev tooling
# from the layer copied into the runtime image. Same shape as
# packages/agent-pod/Dockerfile.
# ---------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the install layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/agent-loop/package.json packages/agent-loop/
COPY packages/agent-pod/package.json packages/agent-pod/
COPY packages/agent-workflow-runtime/package.json packages/agent-workflow-runtime/
COPY packages/audit-events/package.json packages/audit-events/
COPY packages/blackboard/package.json packages/blackboard/
COPY packages/cache-controller/package.json packages/cache-controller/
COPY packages/capability-types/package.json packages/capability-types/
COPY packages/cli/package.json packages/cli/
COPY packages/dto/package.json packages/dto/
COPY packages/egress-controller/package.json packages/egress-controller/
COPY packages/events/package.json packages/events/
COPY packages/http-tool-provider/package.json packages/http-tool-provider/
COPY packages/in-process-tool-provider/package.json packages/in-process-tool-provider/
COPY packages/keyrotation-controller/package.json packages/keyrotation-controller/
COPY packages/llm-gateway/package.json packages/llm-gateway/
COPY packages/locality-controller/package.json packages/locality-controller/
COPY packages/mcp-tool-provider/package.json packages/mcp-tool-provider/
COPY packages/openai-compat/package.json packages/openai-compat/
COPY packages/operator/package.json packages/operator/
COPY packages/quota-controller/package.json packages/quota-controller/
COPY packages/supervision/package.json packages/supervision/
COPY packages/trace-sinks/package.json packages/trace-sinks/
COPY packages/triggers/package.json packages/triggers/
COPY packages/versioning-controller/package.json packages/versioning-controller/
COPY packages/workbench-api/package.json packages/workbench-api/
COPY packages/workbench-ui/package.json packages/workbench-ui/

RUN pnpm install --frozen-lockfile --prod=false

# Source after install so the node_modules layer survives source edits.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/llm-gateway packages/llm-gateway

# Compile @kagent/llm-gateway (no workspace deps to compile — gateway
# is a leaf package).
RUN pnpm --filter @kagent/llm-gateway build

# Sanity: fail the build if compilation didn't produce the entrypoint.
RUN node -e "require('fs').accessSync('packages/llm-gateway/dist/main.js')"

# Drop devDeps (tsx, vitest, etc.) from node_modules.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------
# Stage 2: runtime — Node 22-alpine. No tsx, no compile-on-run.
# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/llm-gateway

# Default port — the chart can override via env. SecComp-friendly:
# no --inspect, no signals beyond the SIGTERM/SIGINT main.ts handles.
EXPOSE 4000
ENTRYPOINT ["node", "dist/main.js"]
