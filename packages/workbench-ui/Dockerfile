# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Two-stage build for the @kagent/workbench-ui image. Stage 1 runs the
# vite build under Node 22 + pnpm; stage 2 bakes the resulting `dist/`
# into nginx-alpine for static-file serving. The final image listens on
# `$PORT` (default 8081) per the workbench Helm chart's sidecar
# contract — see packages/operator/charts/kagent-workbench/templates/
# deployment.yaml's ui container.
#
# Build context = REPO ROOT (so the workspace install can pull the
# @kagent/dto sibling package + any other workspace deps):
#   docker build -t ghcr.io/ctkadvisors/kagent-workbench-ui:<tag> \
#     -f packages/workbench-ui/Dockerfile .

# ---------------------------------------------------------------------
# Stage 1: build — pnpm-driven workspace install + vite build.
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
COPY packages/dto/src packages/dto/src
COPY packages/workbench-ui/src packages/workbench-ui/src
COPY packages/workbench-ui/index.html packages/workbench-ui/
COPY packages/workbench-ui/vite.config.ts packages/workbench-ui/
COPY packages/workbench-ui/tsconfig.json packages/workbench-ui/
COPY packages/workbench-ui/tsconfig.build.json packages/workbench-ui/
COPY tsconfig.base.json ./

RUN pnpm --filter @kagent/workbench-ui build

# ---------------------------------------------------------------------
# Stage 2: runtime — nginx:alpine. Static-file server only; no API
# proxy here (the chart deploys this as a sidecar to the workbench-api
# Pod, and the api container is responsible for routing /api/* to
# itself and proxying everything else to this sidecar over loopback).
#
# nginx:alpine since 1.19 envsubst's /etc/nginx/templates/*.template
# into /etc/nginx/conf.d/ at container start — used here so the chart
# can override the listen port via the standard PORT env var.
# ---------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Default port matches packages/operator/charts/kagent-workbench/
# values.yaml `ui.port: 8081`. Chart overrides via PORT env.
ENV PORT=8081

# Strip the default site so envsubst's rendered config wins. nginx's
# entrypoint scans /etc/nginx/conf.d/ at boot.
RUN rm -f /etc/nginx/conf.d/default.conf

# Static bundle. The vite build emits to packages/workbench-ui/dist/.
COPY --from=build /repo/packages/workbench-ui/dist/ /usr/share/nginx/html/

# nginx config template — see Dockerfile sibling default.conf.template.
COPY packages/workbench-ui/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8081

# Default nginx:alpine entrypoint handles PORT envsubst + nginx -g.
