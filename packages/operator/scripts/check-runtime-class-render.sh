#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
#
# WS-C smoke check — assert that overriding
# `agentPod.runtimeClasses.strict=kata` on the kagent-operator chart
# surfaces as `KAGENT_RUNTIME_CLASS_STRICT=kata` on the operator
# Deployment env (which buildJobSpecOptionsFromEnv reads to populate
# the runtimeClasses map per spawned Job per Agent.spec.sandboxProfile).
#
# Why a helm-render check (not a chart-test Job):
#   - The chart does not currently use Helm chart-tests-as-Jobs (only
#     a smoke-test manifest gated by smokeTest.enabled). Adding a new
#     pattern is out of scope.
#   - Whether a strict-profile Agent's spawned Job ends up with
#     `runtimeClassName: kata` is the operator's runtime decision —
#     covered by `job-spec.test.ts` unit tests. What we verify HERE is
#     that the Helm wiring (values → operator-deployment env → operator
#     reads env into BuildJobSpecOptions) does not silently drop the
#     setting on the way through.
#
# Exit codes:
#   0  expected env var is present in the rendered deployment
#   1  rendering failed
#   2  expected env var is missing (Helm wiring regressed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/../charts/kagent-operator" && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "[check-runtime-class-render] helm not on PATH; skipping (set HELM_REQUIRED=1 to fail instead)" >&2
  if [[ "${HELM_REQUIRED:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

RENDERED="$(helm template kagent "$CHART_DIR" \
  --set agentPod.runtimeClasses.strict=kata 2>&1)" || {
  echo "[check-runtime-class-render] helm template failed:" >&2
  echo "$RENDERED" >&2
  exit 1
}

if ! grep -q 'name: KAGENT_RUNTIME_CLASS_STRICT' <<<"$RENDERED"; then
  echo "[check-runtime-class-render] FAIL — KAGENT_RUNTIME_CLASS_STRICT env var missing from rendered Deployment" >&2
  echo "[check-runtime-class-render] (with --set agentPod.runtimeClasses.strict=kata)" >&2
  exit 2
fi

if ! grep -q '"kata"' <<<"$RENDERED"; then
  echo "[check-runtime-class-render] FAIL — KAGENT_RUNTIME_CLASS_STRICT value 'kata' missing from rendered Deployment" >&2
  exit 2
fi

echo "[check-runtime-class-render] OK — strict→kata wiring renders as expected"
