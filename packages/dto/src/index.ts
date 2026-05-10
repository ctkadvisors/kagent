/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/dto` — pure DTO + read-model helpers.
 *
 * This package is the substrate's READ contract. It maps raw Kubernetes
 * objects (`AgentTask`, `Job`, `Pod`) into UI-friendly summaries that any
 * client — Workbench GUI, CLI, webhook receiver, scheduler — can consume
 * identically without re-deriving the same projection logic.
 *
 * Hard constraints (per Workstream 1 brief, 2026-04-27):
 *
 *   - PURE FUNCTIONS ONLY. No HTTP, no `kc.makeApiClient()`, no `fetch()`,
 *     no file I/O. Callers compose these mappers with whatever transport
 *     they want.
 *   - Depends ONLY on `@kubernetes/client-node` (for type imports) and on
 *     a copy of the operator's CRD type shapes. No workspace dep on
 *     `@kagent/operator` — see `failure.ts` for the dep-direction
 *     rationale.
 *   - The DTO shapes are the public surface; the mapping fns are the
 *     library's value. Adding a field to a DTO is a SemVer-minor; renaming
 *     or removing one is a SemVer-major.
 *
 * Naming convention: `taskSummary(task, opts?) → TaskSummary`. Mappers
 * never throw; they degrade missing inputs to `undefined` fields.
 */

export type {
  AgentSummary,
  AgentTaskCounts,
  ArtifactSummary,
  EventSummary,
  PodFailureSummary,
  TaskDetail,
  TaskSummary,
  TraceLink,
} from './types.js';

export { agentSummary, podFailureSummary, taskDetail, taskSummary, traceLink } from './map.js';

export type {
  AgentSummaryOptions,
  TaskDetailOptions,
  TaskSummaryOptions,
  TraceLinkOptions,
} from './map.js';

// Re-export the canonical FailureVerdict shape so clients don't have to
// import from @kagent/operator. See packages/dto/src/failure.ts for the
// rationale on why this lives in @kagent/dto rather than being
// re-exported from the operator.
export type { FailureVerdict } from './failure.js';
export { detectFailure, detectJobFailure, detectPodFailure } from './failure.js';

// CRD shapes — re-exported so a Workbench-side caller can build fixtures
// without depending on @kagent/operator. See src/crds.ts for the
// duplication rationale.
export type {
  Agent,
  AgentSpec,
  AgentTask,
  AgentTaskPhase,
  AgentTaskSpec,
  AgentTaskStatus,
  AggregatePhase,
  ArtifactRef,
  ChildRef,
  ModelEndpoint,
  ModelEndpointBackendKind,
  ModelEndpointInFlight,
  ModelEndpointSpec,
  ModelEndpointStatus,
} from './crds.js';
export { API_GROUP, API_GROUP_VERSION, API_VERSION, isModelEndpoint } from './crds.js';

// Phase 1 / DISP-01 — AgentDisposition overlay parser. Single source
// of truth for the overlay spec shape; consumed by both
// @kagent/operator (cap-issuer narrowing + overlay-loader) and
// @kagent/workbench-api (dispositions projection).
export type { DispositionOverlay, ParseResult, ProposalKind } from './disposition-parser.js';
export {
  DISPOSITION_AGENT_REF_ANNOTATION,
  DISPOSITION_LABEL,
  DISPOSITION_PROPOSALS_TODAY_ANNOTATION,
  DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION,
  PROPOSAL_KINDS,
  parseDispositionConfigMap,
} from './disposition-parser.js';

// Phase 1 / DISP-03 — DispositionOverlayRow read projection.
// Single source of truth for the workbench-api → workbench-ui DTO
// shape; the workbench-api computes it, workbench-ui consumes it.
export type {
  DispositionOverBudgetReason,
  DispositionOverlayRow,
  DispositionProposalKind,
} from './disposition.js';
export { assertIsDispositionOverlayRow } from './disposition.js';

// Phase 4 / REV-01 — ReviewQueueRow read projection.
// Single source of truth for the workbench-api → workbench-ui DTO
// shape; the workbench-api computes it, workbench-ui consumes it.
// Mirrors the DispositionOverlayRow pattern (DISP-03 / Phase 1).
export type { ArtifactRefSummary, ReviewQueueRow, ReviewReason } from './review-queue.js';
export { assertIsReviewQueueRow } from './review-queue.js';

// Phase 4 / REV-02 — AgentTemplateSpec YAML parser.
// Used by the accept handler in workbench-api to validate candidate
// template YAML before creating an AgentTemplate CR.
export type {
  AgentTemplateBudget,
  AgentTemplateParameter,
  AgentTemplateParameterType,
  AgentTemplateSpec,
  ParseAgentTemplateSpecResult,
} from './template-candidate.js';
export { parseAgentTemplateSpec } from './template-candidate.js';
