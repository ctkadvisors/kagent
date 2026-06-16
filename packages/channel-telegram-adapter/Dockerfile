# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Multi-stage build for @kagent/channel-telegram-adapter. The runtime
# long-polls the Telegram Bot API, posts normalized inbound envelopes to
# the operator's channel gateway, sends completed task replies with
# sendMessage, and patches Channel.status with heartbeat state.
#
# Build context = REPO ROOT:
#   docker buildx build \
#     -t ghcr.io/ctkadvisors/kagent-channel-telegram-adapter:<tag> \
#     -f packages/channel-telegram-adapter/Dockerfile \
#     --platform linux/amd64 .

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/channel-telegram-adapter/package.json packages/channel-telegram-adapter/

RUN pnpm install --frozen-lockfile --prod=false --filter @kagent/channel-telegram-adapter...

COPY tsconfig.base.json ./
COPY packages/channel-telegram-adapter packages/channel-telegram-adapter

RUN pnpm --filter @kagent/channel-telegram-adapter build
RUN node -e "require('fs').accessSync('packages/channel-telegram-adapter/dist/main.js')"
RUN pnpm install --frozen-lockfile --prod --filter @kagent/channel-telegram-adapter...

FROM node:22-alpine AS runtime

USER node
WORKDIR /app

COPY --from=build --chown=node:node /repo /app

WORKDIR /app/packages/channel-telegram-adapter

ENTRYPOINT ["node", "dist/main.js"]
