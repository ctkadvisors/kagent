# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for the kagent-operator image. Stage 1 installs the
# pnpm workspace + compiles every TS package to JS. Stage 2 ships a
# `node:22-alpine`-only runtime that runs `node dist/main.js` — no
# `tsx`, no compile-on-run, no devDeps in the final layer.
#
# Build context = REPO ROOT:
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-operator:<tag> \
#     -f packages/operator/Dockerfile \
#     --platform linux/amd64,linux/arm64 .

# ---------------------------------------------------------------------
# Stage 1: build — pnpm install (full devDeps) + tsc emit. After
# `pnpm -r build` we run `scripts/rewrite-exports-to-dist.mjs` so every
# workspace package's `exports` map points at compiled JS instead of
# `./src/index.ts`. That is the one transformation that lets the stage
# 2 `node` runtime resolve cross-package imports without `tsx`.
# ---------------------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

# Workspace manifests first so the pnpm install layer survives source
# edits. Listing every workspace package explicitly is verbose but keeps
# `--frozen-lockfile` happy without copying unrelated source.
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

# Source comes after install so node_modules layer survives source
# edits. `tsconfig.base.json` is the shared TS config every package
# extends. Every workspace package's source is copied so
# `pnpm --filter @kagent/operator... build` can resolve every
# transitive @kagent/* import — Wave 4 added several controllers
# (audit-events, capability-types, keyrotation-controller, etc.) that
# the operator imports directly.
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

# Compile every workspace package the operator's transitive graph
# depends on. `--filter @kagent/operator...` walks the workspace dep
# tree (the `...` suffix = "and everything it depends on").
RUN pnpm --filter @kagent/operator... build

# Rewrite every workspace package.json's `exports` from `./src/*.ts`
# to `./dist/*.js`. Plain `node` resolves through this map; tsx in dev
# resolves through the at-rest `./src/*.ts` form (so dev tooling stays
# unchanged in the source tree).
RUN node scripts/rewrite-exports-to-dist.mjs

# Fail fast if compilation didn't actually emit the entrypoint.
# v0.5.0-tenancy moved tsconfig.rootDir from "./src" to "." to admit
# the scripts/ tree (migrate-tenants CLI), so tsc now emits the
# operator entrypoint at `dist/src/main.js` instead of `dist/main.js`.
RUN node -e "require('fs').accessSync('packages/operator/dist/src/main.js')"

# Re-install **prod-only** dependencies. devDeps (tsx, vitest, eslint,
# tsc itself) drop out of node_modules so the runtime layer ships only
# what's needed to run.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------
# Stage 2: runtime — Node 22 base. The operator runs on Node (not Bun)
# because @kubernetes/client-node's Watch path hits a TLS chain
# validation bug under Bun against K3s's self-signed CA, even when the
# same kubeconfig works for one-shot API calls. Revisit when Bun fixes
# undici/TLS parity. See packages/agent-pod/Dockerfile for the same
# rationale on the agent-pod image.
# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

USER node
WORKDIR /app

# Copy the post-build, prod-only workspace tree. The operator runs from
# `/app/packages/operator/dist/main.js`; `node_modules` symlinks resolve
# the @kagent/* workspace deps to their sibling `dist/` directories.
COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/operator

# Plain Node — no tsx loader, no transpile on start. v0.5.0-tenancy
# tsconfig.rootDir change shifted the emit path to dist/src/main.js;
# see the corresponding accessSync sanity check in the build stage.
ENTRYPOINT ["node", "dist/src/main.js"]
