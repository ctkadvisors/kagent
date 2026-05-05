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

# Source after install so node_modules layer survives source edits.
# The workbench-api consumes @kagent/dto today; copying every workspace
# package's source keeps the build context honest if that dep set
# grows (Wave 4 added several controllers under @kagent/*).
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/agent-loop packages/agent-loop
COPY packages/agent-pod packages/agent-pod
COPY packages/agent-workflow-runtime packages/agent-workflow-runtime
COPY packages/audit-events packages/audit-events
COPY packages/blackboard packages/blackboard
COPY packages/cache-controller packages/cache-controller
COPY packages/capability-types packages/capability-types
COPY packages/dto packages/dto
COPY packages/egress-controller packages/egress-controller
COPY packages/events packages/events
COPY packages/http-tool-provider packages/http-tool-provider
COPY packages/in-process-tool-provider packages/in-process-tool-provider
COPY packages/keyrotation-controller packages/keyrotation-controller
COPY packages/locality-controller packages/locality-controller
COPY packages/mcp-tool-provider packages/mcp-tool-provider
COPY packages/openai-compat packages/openai-compat
COPY packages/operator packages/operator
COPY packages/quota-controller packages/quota-controller
COPY packages/supervision packages/supervision
COPY packages/trace-sinks packages/trace-sinks
COPY packages/triggers packages/triggers
COPY packages/versioning-controller packages/versioning-controller
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
