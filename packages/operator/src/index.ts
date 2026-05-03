/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/operator` — Kubernetes control plane that watches Agent +
 * AgentTask + AgentCapability CRDs and materializes pods. Public
 * surface re-exports the testable building blocks; the operator is
 * normally run via `pnpm --filter @kagent/operator start` (entry
 * point: `src/main.ts`, added in Phase 2 C3).
 */

export { StubDispatcher } from './dispatcher.js';
export type { Dispatcher, DispatchedTask } from './dispatcher.js';

export { API_GROUP, API_VERSION, API_GROUP_VERSION, isAgent, isAgentTask } from './crds/index.js';
export type {
  Agent,
  AgentSpec,
  AgentTask,
  AgentTaskSpec,
  AgentTaskStatus,
  AgentTaskPhase,
  AgentTaskRunConfig,
  AgentCapability,
  AgentCapabilitySpec,
} from './crds/index.js';

export {
  DEFAULT_ARTIFACT_PVC,
  INLINE_DEFAULT_MAX_BYTES,
  inlineSafe,
  isArtifactRef,
  parseArtifactUri,
  pvcUri,
} from './crds/index.js';
export type {
  ArtifactRef,
  ArtifactScheme,
  InlineDecision,
  ParsedArtifactUri,
} from './crds/index.js';

export {
  markAgentTaskFailedFromExternal,
  patchStatusWithRetry,
  reconcileAgentTask,
  reconcileParentFromChildEvent,
} from './reconcile.js';
export type {
  MarkFailureAction,
  MarkFailureDeps,
  PatchStatusResult,
  ReconcileDeps,
  ReconcileParentFromChildAction,
  ReconcileParentFromChildDeps,
  ReconcileResult,
} from './reconcile.js';
export { mergeCondition, nextPhase } from './status-transitions.js';
export { buildJobSpec, jobNameForTask } from './job-spec.js';
export type { BuildJobSpecOptions } from './job-spec.js';
export { buildHandler } from './main.js';

export { StaticCapabilityRegistry, StubCapabilityRegistry } from './capability-registry.js';
export type { CapabilityRegistry } from './capability-registry.js';
export { NatsDispatcher, publishSubject } from './nats-dispatcher.js';
export type {
  NatsConnectFn,
  NatsConnectionLike,
  NatsDispatcherOptions,
} from './nats-dispatcher.js';
export { NatsCapabilityRegistry } from './nats-capability-registry.js';
export type { AgentLiveEntry, KvBucketFactory, KvBucketLike } from './nats-capability-registry.js';

export {
  PARENT_TASK_NAME_LABEL,
  PARENT_TASK_NAME_ANNOTATION,
  PARENT_TASK_UID_LABEL,
  aggregateChildren,
  buildChildTaskManifest,
  childRef,
  cycleCheck,
  parentTaskRefFromChild,
} from './task-graph.js';

export {
  AGENT_LABEL,
  buildAdmissionReconciler,
  computeCapacity,
  countInFlightByAgent,
  countInFlightByModel,
  extractModelFromJob,
  selectAdmittable,
} from './admission.js';
export type {
  AdmissionDeps,
  AdmissionReconciler,
  AdmissionSummary,
  AgentLookupFn,
  JobLister,
  JobRef,
  ModelEndpointLister,
  SelectAdmittableInput,
  UnsuspendJobFn,
} from './admission.js';
export type {
  AggregatePhase,
  ChildRef,
  ChildTaskSpec,
  CycleCheckResult,
  ParentStatusProjection,
} from './task-graph.js';
