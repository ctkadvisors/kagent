#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Channel WhatsApp adapter chart smoke check — assert that enabling the
# Baileys adapter renders the auth PVC, namespaced Channel.status RBAC,
# and gateway-token env wiring. Also asserts the chart fails closed when
# the adapter is enabled without the channel gateway.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/../charts/kagent-operator" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "[check-channel-whatsapp-render] helm not on PATH; skipping (set HELM_REQUIRED=1 to fail instead)" >&2
  if [[ "${HELM_REQUIRED:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set channels.gateway.enabled=true \
  --set channels.gateway.authTokenSecretName=kagent-channel-gateway-token \
  --set channels.whatsapp.enabled=true \
  --set channels.whatsapp.channelName=whatsapp-work \
  --set channels.whatsapp.accountId=work 2>&1)" || {
  echo "[check-channel-whatsapp-render] helm template failed:" >&2
  echo "$RENDERED" >&2
  exit 1
}

if ! grep -q 'name: kagent-kagent-operator-channel-whatsapp' <<<"$RENDERED"; then
  echo "[check-channel-whatsapp-render] FAIL — WhatsApp adapter Deployment/ServiceAccount name missing" >&2
  exit 2
fi

if ! grep -q 'ghcr.io/ctkadvisors/kagent-channel-whatsapp-adapter' <<<"$RENDERED"; then
  echo "[check-channel-whatsapp-render] FAIL — adapter image missing" >&2
  exit 2
fi

if ! grep -q 'name: KAGENT_CHANNEL_NAME' <<<"$RENDERED" ||
  ! grep -A1 'name: KAGENT_CHANNEL_NAME' <<<"$RENDERED" | grep -q 'value: "whatsapp-work"'; then
  echo "[check-channel-whatsapp-render] FAIL — channel name env missing" >&2
  exit 2
fi

if ! grep -q 'name: KAGENT_CHANNEL_GATEWAY_TOKEN' <<<"$RENDERED" ||
  ! grep -A4 'name: KAGENT_CHANNEL_GATEWAY_TOKEN' <<<"$RENDERED" | grep -q 'name: "kagent-channel-gateway-token"'; then
  echo "[check-channel-whatsapp-render] FAIL — gateway token secret env missing" >&2
  exit 2
fi

if ! grep -q "resources: \\['channels/status'\\]" <<<"$RENDERED" ||
  ! grep -q "verbs: \\['get', 'patch', 'update'\\]" <<<"$RENDERED"; then
  echo "[check-channel-whatsapp-render] FAIL — Channel.status RBAC missing" >&2
  exit 2
fi

if ! grep -q 'kind: PersistentVolumeClaim' <<<"$RENDERED" ||
  ! grep -q 'mountPath: "/var/lib/kagent/whatsapp-auth"' <<<"$RENDERED"; then
  echo "[check-channel-whatsapp-render] FAIL — auth PVC/mount missing" >&2
  exit 2
fi

set +e
FAIL_OUTPUT="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set channels.whatsapp.enabled=true \
  --set channels.whatsapp.channelName=whatsapp-work \
  --set channels.whatsapp.accountId=work 2>&1)"
FAIL_STATUS=$?
set -e

if [[ "$FAIL_STATUS" -eq 0 ]]; then
  echo "[check-channel-whatsapp-render] FAIL — adapter rendered without channel gateway enabled" >&2
  exit 2
fi

if ! grep -q 'channels.whatsapp.enabled=true requires channels.gateway.enabled=true' <<<"$FAIL_OUTPUT"; then
  echo "[check-channel-whatsapp-render] FAIL — missing fail-closed message for gateway-disabled adapter" >&2
  echo "$FAIL_OUTPUT" >&2
  exit 2
fi

echo "[check-channel-whatsapp-render] OK — WhatsApp adapter chart wiring renders as expected"
