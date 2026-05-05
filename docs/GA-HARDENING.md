# GA Hardening

**Date:** 2026-05-04
**Status:** Enterprise Pilot RC hardening
**Scope:** Workbench evidence surface, capability runtime wiring, audit stamps, and ArgoCD deploy readiness

This document defines the release-candidate evidence pack for an
Enterprise Pilot and the runtime hardening needed to make the cap path
auditable in the deployed stack. The hardening posture is to prove the
substrate behaviors present in the cluster through Workbench API/UI,
audit events, mounted capability bundles, and saved evidence artifacts.

## RC Goal

An Enterprise Pilot RC is ready when an operator can hand a reviewer one
evidence directory that answers:

- What version was exercised?
- Which tasks ran, failed, or completed?
- Which task had a trace link, structural detector verdict, verification
  result, task graph projection, artifact references, and audit stamps?
- Which policy and quota-adjacent fields constrained the run?
- Which failure modes were forced and how did Workbench expose them?

The evidence pack is generated from Workbench read APIs, so it can be
recreated without shell access to the cluster control plane.

## Workbench Evidence Surface

`GET /api/tasks/:namespace/:name` now includes `pilotEvidence` alongside
the existing task detail projection.

`pilotEvidence` is read-only and derived from cached CRD objects:

- `audit`: filtered `kagent.knuteson.io/*`, `app.kubernetes.io/*`, and
  Argo CD metadata labels/annotations, including tenant and creation
  stamps when present.
- `policy`: target Agent tools, capabilities, child allowlists,
  `maxConcurrentChildren`, and `maxInFlightTasks`.
- `taskGraph`: parent UID, child count, aggregate phase, and
  success/failure/in-flight child counters.
- `artifacts`: count of `status.artifacts` refs.
- `structuralVerdict`: detector suspicious tags.
- `verification`: `status.verification` pass/fail result when a verifier
  has run.
- `capabilityRef`: capability-bundle reference when the caps path stamps
  one.
- `runConfig`: timeout/iteration/token/cost knobs visible on the task spec.

The Workbench detail UI renders these into an `RC Evidence` section so a
reviewer does not need to inspect raw JSON for common pilot signals. The
raw JSON remains available in the evidence pack.

## Evidence Collector

Run from the repository root:

```bash
node scripts/collect-workbench-evidence.mjs \
  --base-url http://127.0.0.1:18999 \
  --namespace kagent-system \
  --out evidence/enterprise-pilot-rc1
```

The collector writes:

- `manifest.json`: capture time, source URL, selected tasks, and file list.
- `healthz.json` and `readyz.json`: API liveness/readiness snapshots.
- `tasks.json`: task list response.
- `task-details/*.json`: task detail responses including `pilotEvidence`.
- `summary.md`: reviewer-readable matrix for verification, structural
  verdict, trace, artifacts, task graph, and audit stamps.

When Workbench auth is required, the script sends `X-Forwarded-User` by
default. Override it with `--user <name>` or add headers with
`--header key=value`.

## Required Pilot Runs

Capture at least these tasks in one evidence directory:

| Run | Purpose | Required evidence |
| --- | --- | --- |
| Happy path | Prove task dispatch and completion | `phase=Completed`, clean structural verdict, trace link or run ID, result payload |
| Forced model timeout | Prove terminal failure visibility | `phase=Failed`, timeout/deadline error, pod/container status when present |
| Forced image pull or bad pod | Prove platform failure classification | Job/Pod detail shows waiting or terminal reason |
| Delegation graph | Prove parent/child projection | parent has `children`, `aggregatePhase`, and child counters |
| Artifact producer | Prove output refs | `status.artifacts` count and artifact rows in UI/detail JSON |
| Verifier | Prove contract gate evidence | `pilotEvidence.verification.passed` and completed timestamp |
| Policy cap | Prove control-plane constraints are visible | Agent policy shows child allowlists and in-flight/concurrency caps |
| Audit stamps | Prove review correlation | task metadata includes tenant/created-by/managed-by/capability refs where configured |

## Capability Runtime Gate

For GA evidence, the deployed operator should run with:

- `capabilities.enabled=true` and a signing Secret mounted into the
  operator.
- JWKS service enabled so agent-pods can verify mounted cap JWTs.
- `keyRotation.enabled=true` so per-task caps use the configured TTL
  policy and emit `keyrotation.cap_minted_with_ttl`.
- `audit.enabled=true` so the operator emits `capability.minted` and
  agent-pods emit `capability.used` on successful cap-gated spawn.
- `tenancy.enabled=true` when Tenant CRs are present, so minted caps
  include `claims.tenant` and per-tenant issuer overrides.

## Acceptance Gates

The Enterprise Pilot RC evidence pack passes when:

- The evidence directory contains one `manifest.json`, one `summary.md`,
  and task-detail JSON for every required run.
- `readyz.json` reports Workbench cache readiness at capture time.
- Every completed task has either a clean structural verdict or an
  explicitly reviewed suspicious-tag note in `summary.md`.
- Every task that claims external evidence has either a trace link/run ID,
  artifact ref, verifier result, or audit stamp in the task detail JSON.
- Forced failure tasks show substrate failure state distinctly from model
  output.
- At least one cap-gated task has `status.capabilityRef`, a mounted
  Secret-backed JWT, a `capability.minted` audit event, and a successful
  `capability.used` event when spawn is exercised.
- No evidence depends on controller logs as the only source of truth.

## Non-Goals

- No new trace database.
- No arbitrary YAML editor or write action beyond the existing Workbench
  task creation surface.
- No claim that every Wave 4 quota enforcement path is complete. This RC
  requires cap/tenant visibility and the quota fields that exist on CRD
  objects today.
