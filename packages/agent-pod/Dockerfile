# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the @kagent/agent-pod runtime image. Final
# image is `oven/bun:1.1-alpine`-based; Bun executes TypeScript
# directly, no compile step.
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
# Stage 2: runtime — Bun-based, lean.
# ---------------------------------------------------------------------
FROM oven/bun:1.1-alpine AS runtime

# Run as non-root. The bun base image already provides a `bun` user.
USER bun
WORKDIR /app

# Copy the resolved workspace + node_modules from the install stage.
# `node_modules` includes the pnpm-isolated symlinks; Bun's resolver
# follows them.
COPY --from=install --chown=bun:bun /repo /app

WORKDIR /app/packages/agent-pod

# Bun runs main.ts directly. Operator's job-spec sets the KAGENT_* env.
ENTRYPOINT ["bun", "src/main.ts"]
