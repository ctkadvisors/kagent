# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the @kagent/workbench-api image. Stage 1
# installs the full pnpm workspace + compiles every transitive TS dep
# to JS. Stage 2 ships a `node:22-alpine`-only runtime that runs
# `node dist/main.js` — no `tsx`, no compile-on-run.
#
# Build context = REPO ROOT (so the workspace install can pull the
# @kagent/dto sibling package + any future workspace deps):
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-workbench-api:<tag> \
#     -f packages/workbench-api/Dockerfile \
#     --platform linux/amd64,linux/arm64 .

# ---------------------------------------------------------------------
# Stage 1: build — pnpm install (full devDeps), tsc emit, exports
# rewrite, prod-only re-install.
# ---------------------------------------------------------------------
FROM node:22-alpine AS build

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
# Only the packages the workbench-api transitively needs.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/dto packages/dto
COPY packages/workbench-api packages/workbench-api

# Compile @kagent/workbench-api + transitive deps.
RUN pnpm --filter @kagent/workbench-api... build

# Rewrite each workspace package's exports map from src/.ts to dist/.js.
RUN node scripts/rewrite-exports-to-dist.mjs

# Sanity: fail the build if compilation didn't produce the entrypoint.
RUN node -e "require('fs').accessSync('packages/workbench-api/dist/main.js')"

# Drop devDeps from node_modules.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------
# Stage 2: runtime — Node 22. tsx is gone in this image; we run
# `node dist/main.js` directly. Runtime kept on Node (not Bun) for
# @kubernetes/client-node TLS parity against K3s self-signed CAs —
# same constraint as the operator. See packages/operator/Dockerfile
# for the original rationale.
# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/workbench-api

# Plain Node 22 — no tsx loader, no transpile on start.
ENTRYPOINT ["node", "dist/main.js"]
