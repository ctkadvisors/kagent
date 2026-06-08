#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Architect chart smoke check — assert that enabling the kagent
# workbench Architect write path can render the draft namespace RBAC
# it needs to create AgentTemplate, Agent, and AgentTask resources.
#
# Exit codes:
#   0  expected draft Role + RoleBinding are present
#   1  rendering failed
#   2  expected manifest wiring is missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/../charts/kagent-workbench" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "[check-workbench-architect-rbac-render] helm not on PATH; skipping (set HELM_REQUIRED=1 to fail instead)" >&2
  if [[ "${HELM_REQUIRED:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

DEFAULT_RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set api.architect.enabled=true \
  --set api.architect.gatewayUrl=http://gateway.example/v1 \
  --set api.architect.model=test-model \
  --set rbac.actions.create=true 2>&1)" || {
  echo "[check-workbench-architect-rbac-render] helm template failed:" >&2
  echo "$DEFAULT_RENDERED" >&2
  exit 1
}

if ! grep -q 'name: KAGENT_DRAFT_NAMESPACE' <<<"$DEFAULT_RENDERED" ||
  ! grep -A1 'name: KAGENT_DRAFT_NAMESPACE' <<<"$DEFAULT_RENDERED" | grep -q 'value: "kagent-system"'; then
  echo "[check-workbench-architect-rbac-render] FAIL — default Architect draft namespace must be the release namespace" >&2
  exit 2
fi

if ! grep -q "resources: \\['agents'\\]" <<<"$DEFAULT_RENDERED" || ! grep -q "verbs: \\['create'\\]" <<<"$DEFAULT_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — release-namespace actions Role must grant agents:create for /api/architect/try" >&2
  exit 2
fi

CROSS_NS_RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set api.architect.enabled=true \
  --set api.architect.gatewayUrl=http://gateway.example/v1 \
  --set api.architect.model=test-model \
  --set api.architect.draftNamespace=kagent-draft \
  --set api.architect.draftRbac.create=true \
  --set rbac.actions.create=true 2>&1)" || {
  echo "[check-workbench-architect-rbac-render] helm template failed:" >&2
  echo "$CROSS_NS_RENDERED" >&2
  exit 1
}

if ! grep -q 'name: kagent-kagent-workbench-architect-draft' <<<"$CROSS_NS_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — draft architect Role/RoleBinding name missing" >&2
  exit 2
fi

if ! grep -q 'namespace: kagent-draft' <<<"$CROSS_NS_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — draft namespace missing from rendered RBAC" >&2
  exit 2
fi

if ! grep -q "resources: \\['agenttemplates', 'agents', 'agenttasks'\\]" <<<"$CROSS_NS_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — draft write resources missing" >&2
  exit 2
fi

if ! grep -q "verbs: \\['create', 'get', 'list', 'watch', 'delete', 'patch'\\]" <<<"$CROSS_NS_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — draft write verbs missing" >&2
  exit 2
fi

if ! grep -q 'name: kagent-workbench' <<<"$CROSS_NS_RENDERED" || ! grep -q 'namespace: kagent-system' <<<"$CROSS_NS_RENDERED"; then
  echo "[check-workbench-architect-rbac-render] FAIL — ServiceAccount subject binding missing" >&2
  exit 2
fi

echo "[check-workbench-architect-rbac-render] OK — Architect draft RBAC renders as expected"
