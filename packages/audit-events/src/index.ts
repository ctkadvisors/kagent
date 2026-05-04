/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/audit-events` — CloudEvents v1.0 envelope + NATS JetStream
 * publisher for the kagent substrate audit stream.
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §4.3 (Audit cross-cutting concern)
 *   - docs/WAVES.md §2.5 (Wave 0 Audit sub-team brief)
 *
 * Wave 0 ships the FOUNDATION:
 *   - The CloudEvents envelope shape + builder (`makeEvent`)
 *   - The complete event-type catalog (10 types)
 *   - `AuditPublisher` — graceful no-op-on-unreachable NATS publisher
 *
 * Wave 0 proof-of-life emission point: operator's admission reconciler
 * fires `task.admitted` per accepted AgentTask. Every other emission
 * site is added by its owning sub-team in subsequent commits per the
 * WAVES.md plan.
 */

export type {
  AdmissionPodPressureDeferredData,
  AuditEvent,
  AuditEventData,
  AuditEventType,
  CacheHitData,
  CacheMissData,
  CapabilityMintedData,
  CapabilityUsedData,
  ChildSpawnedData,
  CloudEvent,
  ContractViolatedData,
  IdentityRotationData,
  IdentitySvidIssuedData,
  InfraFaultObservedData,
  LocalitySpeculativeSpawnedData,
  LocalitySpeculativeSupersededData,
  QuotaBreachedData,
  SecretAccessedData,
  SupervisionAppliedData,
  SupervisionRestartLimitExceededData,
  TaskAdmittedData,
  TaskCompletedData,
  TaskFailedData,
  TaskSpawnedData,
  EgressPolicyAppliedData,
  EgressPolicyViolationData,
  TenantAdmissionViolationData,
  TenantLifecycleData,
  TenantMigrationData,
  WorkflowCompletedData,
  WorkflowEventSubscriptionPendingData,
  WorkflowFailedData,
  WorkflowStartedData,
  WorkflowStepCompletedData,
} from './types.js';

export {
  ADMISSION_POD_PRESSURE_DEFERRED,
  ALL_EVENT_TYPES,
  CACHE_HIT,
  CACHE_MISS,
  CAPABILITY_MINTED,
  CAPABILITY_USED,
  CHILD_SPAWNED,
  CONTRACT_VIOLATED,
  EGRESS_POLICY_APPLIED,
  EGRESS_POLICY_VIOLATION,
  IDENTITY_ROTATION,
  IDENTITY_SVID_ISSUED,
  INFRA_FAULT_OBSERVED,
  LOCALITY_SPECULATIVE_SPAWNED,
  LOCALITY_SPECULATIVE_SUPERSEDED,
  QUOTA_BREACHED,
  SECRET_ACCESSED,
  SUPERVISION_APPLIED,
  SUPERVISION_RESTART_LIMIT_EXCEEDED,
  TASK_ADMITTED,
  TASK_COMPLETED,
  TASK_FAILED,
  TASK_SPAWNED,
  TENANT_ADMISSION_VIOLATION,
  TENANT_CREATED,
  TENANT_DELETED,
  TENANT_MIGRATION,
  TENANT_UPDATED,
  WORKFLOW_COMPLETED,
  WORKFLOW_EVENT_SUBSCRIPTION_PENDING,
  WORKFLOW_FAILED,
  WORKFLOW_STARTED,
  WORKFLOW_STEP_COMPLETED,
} from './event-types.js';

export { makeEvent } from './make-event.js';
export type { MakeEventInput, MakeEventOpts } from './make-event.js';

export { AuditPublisher } from './publisher.js';
export type {
  AuditConnectFn,
  AuditLogger,
  AuditNatsConnectionLike,
  AuditPublisherOptions,
} from './publisher.js';
