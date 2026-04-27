# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the kagent-operator image. Mirrors the
# agent-pod Dockerfile shape but the runtime stage runs the operator
# entrypoint instead.
#
# Build context = REPO ROOT:
#   docker build -t ghcr.io/ctkadvisors/kagent-operator:v0.0.4-phase4 \
#     -f packages/operator/Dockerfile .

# ---------------------------------------------------------------------
# Stage 1: install — pnpm-driven workspace install.
# ---------------------------------------------------------------------
FROM node:22-alpine AS install

RUN corepack enable

WORKDIR /repo

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

COPY packages/agent-loop/src packages/agent-loop/src
COPY packages/openai-compat/src packages/openai-compat/src
COPY packages/in-process-tool-provider/src packages/in-process-tool-provider/src
COPY packages/mcp-tool-provider/src packages/mcp-tool-provider/src
COPY packages/http-tool-provider/src packages/http-tool-provider/src
COPY packages/trace-sinks/src packages/trace-sinks/src
COPY packages/operator/src packages/operator/src
COPY tsconfig.base.json ./

# ---------------------------------------------------------------------
# Stage 2: runtime — Bun base. The operator uses Bun for the same
# reason as the agent-pod (TS-first, lean image).
# ---------------------------------------------------------------------
FROM oven/bun:1.1-alpine AS runtime

USER bun
WORKDIR /app

COPY --from=install --chown=bun:bun /repo /app

WORKDIR /app/packages/operator

ENTRYPOINT ["bun", "src/main.ts"]
