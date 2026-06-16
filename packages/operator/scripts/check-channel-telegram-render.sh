#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Channel Telegram adapter chart smoke check — assert that enabling the
# Bot API adapter renders namespaced Channel.status RBAC, bot-token env
# wiring, and gateway-token env wiring. Also asserts the chart fails
# closed when the adapter is enabled without the channel gateway.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/../charts/kagent-operator" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "[check-channel-telegram-render] helm not on PATH; skipping (set HELM_REQUIRED=1 to fail instead)" >&2
  if [[ "${HELM_REQUIRED:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set channels.gateway.enabled=true \
  --set channels.gateway.authTokenSecretName=kagent-channel-gateway-token \
  --set channels.telegram.enabled=true \
  --set channels.telegram.channelName=telegram-work \
  --set channels.telegram.accountId=work \
  --set channels.telegram.botTokenSecretName=kagent-telegram-bot-token 2>&1)" || {
  echo "[check-channel-telegram-render] helm template failed:" >&2
  echo "$RENDERED" >&2
  exit 1
}

if ! grep -q 'name: kagent-kagent-operator-channel-telegram' <<<"$RENDERED"; then
  echo "[check-channel-telegram-render] FAIL — Telegram adapter Deployment/ServiceAccount name missing" >&2
  exit 2
fi

if ! grep -q 'ghcr.io/ctkadvisors/kagent-channel-telegram-adapter' <<<"$RENDERED"; then
  echo "[check-channel-telegram-render] FAIL — adapter image missing" >&2
  exit 2
fi

if ! grep -q 'name: KAGENT_CHANNEL_NAME' <<<"$RENDERED" ||
  ! grep -A1 'name: KAGENT_CHANNEL_NAME' <<<"$RENDERED" | grep -q 'value: "telegram-work"'; then
  echo "[check-channel-telegram-render] FAIL — channel name env missing" >&2
  exit 2
fi

if ! grep -q 'name: KAGENT_TELEGRAM_BOT_TOKEN' <<<"$RENDERED" ||
  ! grep -A4 'name: KAGENT_TELEGRAM_BOT_TOKEN' <<<"$RENDERED" | grep -q 'name: "kagent-telegram-bot-token"'; then
  echo "[check-channel-telegram-render] FAIL — Telegram bot token secret env missing" >&2
  exit 2
fi

if ! grep -q 'name: KAGENT_CHANNEL_GATEWAY_TOKEN' <<<"$RENDERED" ||
  ! grep -A4 'name: KAGENT_CHANNEL_GATEWAY_TOKEN' <<<"$RENDERED" | grep -q 'name: "kagent-channel-gateway-token"'; then
  echo "[check-channel-telegram-render] FAIL — gateway token secret env missing" >&2
  exit 2
fi

if ! grep -q "resources: \\['channels/status'\\]" <<<"$RENDERED" ||
  ! grep -q "verbs: \\['get', 'patch', 'update'\\]" <<<"$RENDERED"; then
  echo "[check-channel-telegram-render] FAIL — Channel.status RBAC missing" >&2
  exit 2
fi

if grep -q 'channel-telegram-auth' <<<"$RENDERED" ||
  grep -q 'mountPath: "/var/lib/kagent/telegram' <<<"$RENDERED"; then
  echo "[check-channel-telegram-render] FAIL — Telegram adapter should not render auth storage" >&2
  exit 2
fi

set +e
FAIL_OUTPUT="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set channels.telegram.enabled=true \
  --set channels.telegram.channelName=telegram-work \
  --set channels.telegram.accountId=work \
  --set channels.telegram.botTokenSecretName=kagent-telegram-bot-token 2>&1)"
FAIL_STATUS=$?
set -e

if [[ "$FAIL_STATUS" -eq 0 ]]; then
  echo "[check-channel-telegram-render] FAIL — adapter rendered without channel gateway enabled" >&2
  exit 2
fi

if ! grep -q 'channels.telegram.enabled=true requires channels.gateway.enabled=true' <<<"$FAIL_OUTPUT"; then
  echo "[check-channel-telegram-render] FAIL — missing fail-closed message for gateway-disabled adapter" >&2
  echo "$FAIL_OUTPUT" >&2
  exit 2
fi

set +e
MISSING_SECRET_OUTPUT="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set channels.gateway.enabled=true \
  --set channels.gateway.authTokenSecretName=kagent-channel-gateway-token \
  --set channels.telegram.enabled=true \
  --set channels.telegram.channelName=telegram-work \
  --set channels.telegram.accountId=work 2>&1)"
MISSING_SECRET_STATUS=$?
set -e

if [[ "$MISSING_SECRET_STATUS" -eq 0 ]]; then
  echo "[check-channel-telegram-render] FAIL — adapter rendered without bot token Secret name" >&2
  exit 2
fi

if ! grep -q 'channels.telegram.enabled=true requires channels.telegram.botTokenSecretName' <<<"$MISSING_SECRET_OUTPUT"; then
  echo "[check-channel-telegram-render] FAIL — missing fail-closed message for bot token Secret" >&2
  echo "$MISSING_SECRET_OUTPUT" >&2
  exit 2
fi

echo "[check-channel-telegram-render] OK — Telegram adapter chart wiring renders as expected"
