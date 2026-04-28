# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the @kagent/agent-pod runtime image. Stage 1
# installs the full pnpm workspace + compiles every transitive TS
# dependency to JS via `pnpm --filter @kagent/agent-pod... build`.
# Stage 2 ships a `node:22-alpine`-only runtime that runs
# `node dist/main.js` — no `tsx`, no compile-on-run.
#
# Build context = REPO ROOT (so the workspace install pulls every
# sibling package). From the repo root:
#
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-agent-pod:<tag> \
#     -f packages/agent-pod/Dockerfile \
#     --platform linux/amd64,linux/arm64 .
#
# Image expects KAGENT_* env vars (set by the operator's job-spec
# builder) at runtime. See packages/agent-pod/src/env.ts.

# ---------------------------------------------------------------------
# Stage 1: build — pnpm install (full devDeps), tsc emit, exports
# rewrite, then a final prod-only `pnpm install` to drop dev tooling
# from the layer that gets copied into the runtime image.
# ---------------------------------------------------------------------
FROM node:22-alpine AS build

# Enable corepack so the pinned pnpm@9.15.9 from package.json is used.
RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the install layer survives source edits.
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

# Source after install so the node_modules layer survives source edits.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/agent-loop packages/agent-loop
COPY packages/openai-compat packages/openai-compat
COPY packages/in-process-tool-provider packages/in-process-tool-provider
COPY packages/mcp-tool-provider packages/mcp-tool-provider
COPY packages/http-tool-provider packages/http-tool-provider
COPY packages/trace-sinks packages/trace-sinks
COPY packages/agent-pod packages/agent-pod

# Compile @kagent/agent-pod and every workspace package it depends on.
RUN pnpm --filter @kagent/agent-pod... build

# Rewrite each workspace package's exports map from `./src/*.ts` to
# `./dist/*.js` so plain Node resolves to compiled output.
RUN node scripts/rewrite-exports-to-dist.mjs

# Sanity: fail the build if compilation didn't produce the entrypoint.
RUN node -e "require('fs').accessSync('packages/agent-pod/dist/main.js')"

# Drop devDeps (tsx, vitest, etc.) from node_modules.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------
# Stage 2: runtime — Node 22. Originally Bun (per CLAUDE.md
# "Bun is the runtime, both for the operator and inside agent pods"),
# but @kubernetes/client-node 1.4.0 hits a TLS chain validation bug
# under Bun against K3s's self-signed CA — affects both the operator
# Watch path AND the agent-pod's status writeback. Switched to Node
# 22 + tsx for parity with the operator. Revisit when Bun fixes
# undici/TLS parity, or pin a workaround.
# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/agent-pod

# Plain Node 22 — no tsx loader, no transpile on start.
ENTRYPOINT ["node", "dist/main.js"]
