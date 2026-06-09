#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# Workbench terminate RBAC render check. The default actions Role stays
# namespace-scoped; the optional emergency terminate grant is a separate
# ClusterRole with ONLY agenttasks:delete.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/../charts/kagent-workbench" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "[check-workbench-terminate-rbac-render] helm not on PATH; skipping (set HELM_REQUIRED=1 to fail instead)" >&2
  if [[ "${HELM_REQUIRED:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

DEFAULT_RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set rbac.actions.create=true 2>&1)" || {
  echo "[check-workbench-terminate-rbac-render] helm template failed:" >&2
  echo "$DEFAULT_RENDERED" >&2
  exit 1
}

if grep -q 'name: kagent-kagent-workbench-terminate-all-namespaces' <<<"$DEFAULT_RENDERED"; then
  echo "[check-workbench-terminate-rbac-render] FAIL — default render must not grant cluster-wide terminate" >&2
  exit 2
fi

OPT_IN_RENDERED="$(helm template kagent "$CHART_DIR" \
  --namespace kagent-system \
  --set rbac.actions.create=true \
  --set rbac.actions.terminateAllNamespaces=true 2>&1)" || {
  echo "[check-workbench-terminate-rbac-render] helm template failed:" >&2
  echo "$OPT_IN_RENDERED" >&2
  exit 1
}

if ! grep -q 'kind: ClusterRole' <<<"$OPT_IN_RENDERED" ||
  ! grep -q 'name: kagent-kagent-workbench-terminate-all-namespaces' <<<"$OPT_IN_RENDERED"; then
  echo "[check-workbench-terminate-rbac-render] FAIL — opt-in ClusterRole missing" >&2
  exit 2
fi

if ! grep -q "resources: \\['agenttasks'\\]" <<<"$OPT_IN_RENDERED" ||
  ! grep -q "verbs: \\['delete'\\]" <<<"$OPT_IN_RENDERED"; then
  echo "[check-workbench-terminate-rbac-render] FAIL — terminate ClusterRole must grant only agenttasks:delete" >&2
  exit 2
fi

if ! grep -q 'kind: ClusterRoleBinding' <<<"$OPT_IN_RENDERED"; then
  echo "[check-workbench-terminate-rbac-render] FAIL — opt-in ClusterRoleBinding missing" >&2
  exit 2
fi

echo "[check-workbench-terminate-rbac-render] OK — terminate RBAC renders as expected"
