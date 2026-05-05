# GA Evidence Checklist

**Date:** 2026-05-04
**Audience:** Enterprise Pilot reviewer
**Primary source:** Workbench API evidence pack

Use this checklist against an output directory produced by
`scripts/collect-workbench-evidence.mjs`. Store the completed directory as
the RC evidence artifact for the pilot.

## Capture Metadata

| Check | Pass criteria | Evidence path |
| --- | --- | --- |
| Capture manifest | `manifest.json` has `generatedAt`, `baseUrl`, `taskCount`, and `detailCount` | `manifest.json` |
| API liveness | Workbench API responds with status ok | `healthz.json` |
| API readiness | Workbench cache has observed tasks/agents or readiness is explicitly reviewed | `readyz.json` |
| Task inventory | Task list includes every pilot run by namespace/name | `tasks.json` |
| Detail inventory | Each pilot task has a detail JSON file | `task-details/*.json` |
| Reviewer matrix | Summary table has one row per captured detail | `summary.md` |

## Task Evidence

| Check | Pass criteria | Workbench field |
| --- | --- | --- |
| Completion state | Happy-path task is `Completed`; forced failures are `Failed` | `phase` |
| Timing | Created, started, and completed timestamps are present where applicable | `createdAt`, `startedAt`, `completedAt` |
| Target resolution | Target Agent/capability and model are visible | `targetAgent`, `targetCapability`, `model` |
| Prompt provenance | Original user message and payload are visible | `originalUserMessage`, `payload` |
| Result/error | Terminal task result or error is visible | `result`, `error` |
| Pod evidence | Pod/container state explains platform failures | `containerStatuses` |
| Trace evidence | Trace link resolves or run ID is available for lookup | `traceLink` |
| Detector evidence | Suspicious tags are empty or explicitly reviewed | `suspicious`, `pilotEvidence.structuralVerdict` |
| Verifier evidence | Verifier result is present for verifier-gated tasks | `pilotEvidence.verification` |
| Artifact evidence | Artifact-producing tasks have refs and metadata | `artifacts`, `pilotEvidence.artifacts` |
| Task graph evidence | Delegation tasks show parent/children and aggregate counters | `children`, `aggregatePhase`, `successCount`, `failureCount`, `inFlightCount` |
| Policy evidence | Agent tools, child allowlists, and concurrency caps are visible | `pilotEvidence.policy` |
| Audit evidence | Tenant, created-by, managed-by, parent UID, and capability refs are visible when configured | `pilotEvidence.audit`, `pilotEvidence.capabilityRef` |
| Run config | Timeout/iteration/cost/token knobs are visible when configured | `pilotEvidence.runConfig` |

## Required Scenario Rows

| Scenario | Required task detail evidence |
| --- | --- |
| Happy path | `phase=Completed`, `suspicious=[]`, trace link or run ID, non-empty `result` |
| Model timeout | `phase=Failed`, terminal error mentions timeout/deadline, pod status captured if available |
| Image pull or pod failure | container waiting/terminated reason visible in `containerStatuses` |
| Parent/child delegation | parent row has `childCount > 0`; counters sum to child count |
| Artifact producer | `artifactCount > 0`; artifact table contains URI and media/size when known |
| Contract verifier | `verification.passed=true` for the pass case and a reviewed fail case when applicable |
| Policy cap | `maxConcurrentChildren` or `maxInFlightTasks` visible on the target Agent policy |
| Audit stamps | filtered labels/annotations include tenant or creation stamps for correlation |

## Reviewer Sign-Off

| Item | Decision | Notes |
| --- | --- | --- |
| Evidence pack complete | pass / fail | |
| Forced failures explainable from Workbench | pass / fail | |
| Suspicious detector tags reviewed | pass / fail | |
| Trace/artifact links sufficient for post-run inspection | pass / fail | |
| Policy/audit fields sufficient for pilot accountability | pass / fail | |
| RC accepted for Enterprise Pilot | yes / no | |
