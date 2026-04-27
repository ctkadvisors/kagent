# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the @kagent/agent-pod runtime image. Final
# image is `node:22-alpine`-based with `tsx` executing TypeScript
# directly, no compile step. Bun was the original target (still
# referenced in the runtime stage's comment block below) but reverted
# in Phase 4.x — see the runtime-stage comment for the full reason.
#
# Build context is the REPO ROOT (so the workspace layout + sibling
# packages get installed together). From the repo root:
#
#   docker build \
#     -t ghcr.io/ctkadvisors/kagent-agent-pod:v0.0.3-phase3 \
#     -f packages/agent-pod/Dockerfile \
#     .
#
# Image expects KAGENT_* env vars (set by the operator's job-spec
# builder) at runtime. See packages/agent-pod/src/env.ts.

# ---------------------------------------------------------------------
# Stage 1: install — pnpm-driven workspace install. Uses Node so the
# pnpm engine constraint matches CI. Bun could also do this but the
# pnpm + Node combo is what the rest of the workspace uses.
# ---------------------------------------------------------------------
FROM node:22-alpine AS install

# Enable corepack so the pinned pnpm@9.15.9 from package.json is used.
RUN corepack enable

WORKDIR /repo

# Copy the workspace manifests first so layer cache survives source
# edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/agent-loop/package.json packages/agent-loop/
COPY packages/openai-compat/package.json packages/openai-compat/
COPY packages/in-process-tool-provider/package.json packages/in-process-tool-provider/
COPY packages/mcp-tool-provider/package.json packages/mcp-tool-provider/
COPY packages/http-tool-provider/package.json packages/http-tool-provider/
COPY packages/trace-sinks/package.json packages/trace-sinks/
COPY packages/operator/package.json packages/operator/
COPY packages/agent-pod/package.json packages/agent-pod/

RUN pnpm install --frozen-lockfile --prod=false

# Copy source AFTER install so layer cache survives node_modules.
COPY packages/agent-loop/src packages/agent-loop/src
COPY packages/openai-compat/src packages/openai-compat/src
COPY packages/in-process-tool-provider/src packages/in-process-tool-provider/src
COPY packages/mcp-tool-provider/src packages/mcp-tool-provider/src
COPY packages/http-tool-provider/src packages/http-tool-provider/src
COPY packages/trace-sinks/src packages/trace-sinks/src
COPY packages/agent-pod/src packages/agent-pod/src
COPY tsconfig.base.json ./

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

COPY --from=install --chown=node:node /repo /app

WORKDIR /app/packages/agent-pod

# tsx (devDep) executes TypeScript directly under Node 22.
ENTRYPOINT ["node", "--import", "tsx/esm", "src/main.ts"]
