# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for @kagent/channel-whatsapp-adapter. The runtime
# owns a Baileys WhatsApp-Web session, stores auth material on a PVC,
# posts normalized inbound envelopes to the operator's channel gateway,
# and patches Channel.status with pairing/heartbeat state.
#
# Build context = REPO ROOT:
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-channel-whatsapp-adapter:<tag> \
#     -f packages/channel-whatsapp-adapter/Dockerfile \
#     --platform linux/amd64 .

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/channel-whatsapp-adapter/package.json packages/channel-whatsapp-adapter/

RUN pnpm install --frozen-lockfile --prod=false --filter @kagent/channel-whatsapp-adapter...

COPY tsconfig.base.json ./
COPY packages/channel-whatsapp-adapter packages/channel-whatsapp-adapter

RUN pnpm --filter @kagent/channel-whatsapp-adapter build
RUN node -e "require('fs').accessSync('packages/channel-whatsapp-adapter/dist/main.js')"
RUN pnpm install --frozen-lockfile --prod --filter @kagent/channel-whatsapp-adapter...

FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/channel-whatsapp-adapter

ENTRYPOINT ["node", "dist/main.js"]
