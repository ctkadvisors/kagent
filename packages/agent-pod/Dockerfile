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
# Every workspace package's source is copied so
# `pnpm --filter @kagent/agent-pod... build` resolves every transitive
# @kagent/* import — Wave 4 added several controllers (audit-events,
# capability-types, etc.) that agent-pod imports directly.
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
COPY packages/quota-controller packages/quota-controller
COPY packages/supervision packages/supervision
COPY packages/trace-sinks packages/trace-sinks
COPY packages/triggers packages/triggers
COPY packages/versioning-controller packages/versioning-controller

# Compile @kagent/agent-pod and every workspace package it depends on.
RUN pnpm --filter @kagent/agent-pod... build

# Rewrite each workspace package's exports map from `./src/*.ts` to
# `./dist/*.js` so plain Node resolves to compiled output.
RUN node scripts/rewrite-exports-to-dist.mjs

# Sanity: fail the build if compilation didn't produce the entrypoint.
RUN node -e "require('fs').accessSync('packages/agent-pod/dist/main.js')"

# Drop devDeps (tsx, vitest, etc.) from node_modules.
RUN pnpm install --frozen-lockfile --prod

# L11 (audit-rev2 C3 §1) — slim the artifact that the runtime stage
# copies in. The previous COPY shipped the entire /repo tree
# (including every package's `src/` with co-located `*.test.ts`
# fixtures, vitest configs, eslint configs, scripts/, build-only
# tsconfigs, and per-package `coverage/` if it had been generated).
# None of those are used at runtime — `node dist/main.js` resolves
# only through the dist/ outputs and the workspace-prod node_modules.
#
# Removed from each `packages/*/`:
#   - src/                     (TS source + co-located tests)
#   - *.test.ts / *.test.js    (defense-in-depth; src removal is
#                                already enough but cheap to add)
#   - __fixtures__/            (test data + sample SVIDs / cap JWTs)
#   - vitest.config.{ts,js}    (dev-only; prod uses no test runner)
#   - eslint.config.js         (dev-only; prod runs no linter)
#   - tsconfig*.json           (dev-only; prod runs plain `node`)
#   - .tsbuildinfo             (incremental build state)
#   - coverage/                (test-run artifacts; never present
#                                in clean builds, removed defensively)
# Plus repo-root scripts/ and tsconfig.base.json (build-only helpers).
#
# `dist/` and `package.json` per package are KEPT — those plus the
# pruned workspace `node_modules/` are exactly what `node` needs at
# resolve time. The trust boundary is unchanged: `node:node` still
# owns everything, the entrypoint is unchanged, and the
# `rewrite-exports-to-dist.mjs` pass already aimed every workspace
# symlink at `dist/*.js`.
RUN find /repo/packages -mindepth 2 -maxdepth 2 -type d -name src -prune -exec rm -rf {} + \
 && find /repo/packages -type d -name __fixtures__ -prune -exec rm -rf {} + \
 && find /repo/packages -type d -name coverage -prune -exec rm -rf {} + \
 && find /repo/packages -mindepth 2 -maxdepth 2 -type f \( \
        -name 'vitest.config.ts' \
        -o -name 'vitest.config.js' \
        -o -name 'eslint.config.js' \
        -o -name 'tsconfig.json' \
        -o -name 'tsconfig.eslint.json' \
        -o -name '.tsbuildinfo' \
    \) -delete \
 && find /repo/packages -name '*.test.ts' -delete \
 && find /repo/packages -name '*.test.js' -delete \
 && rm -rf /repo/scripts /repo/tsconfig.base.json

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
