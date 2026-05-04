/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Audit event-type string constants.
 *
 * Exported individually so callsites import the symbol they emit
 * (`import { TASK_ADMITTED } from '@kagent/audit-events'`) — typo-proof,
 * grep-able, and gives `tsc` a fixed-string check at the import site
 * instead of relying on the type-checker to catch a stringly-typed
 * `'task.adimtted'` (sic) at the emission site.
 *
 * Every const here MUST have a corresponding member in
 * `AuditEventType` (types.ts) and in `AuditEventData`'s discriminated
 * union. The single source of truth for the wire string is THIS file;
 * the union in types.ts re-uses the literals so a rename surfaces as
 * a TypeScript error at every call site.
 *
 * Maintained order matches the SUBSTRATE-V1.md §4.3 spec — kept stable
 * for table-of-contents readability across documentation + audit
 * dashboards.
 */

export const TASK_ADMITTED = 'task.admitted' as const;
export const TASK_SPAWNED = 'task.spawned' as const;
export const TASK_COMPLETED = 'task.completed' as const;
export const TASK_FAILED = 'task.failed' as const;
export const CHILD_SPAWNED = 'child.spawned' as const;
export const CAPABILITY_MINTED = 'capability.minted' as const;
export const CAPABILITY_USED = 'capability.used' as const;
export const SECRET_ACCESSED = 'secret.accessed' as const;
export const QUOTA_BREACHED = 'quota.breached' as const;
export const CONTRACT_VIOLATED = 'contract.violated' as const;
/* v0.3.1-supervision — Wave 2 / Supervision sub-team. */
export const SUPERVISION_APPLIED = 'supervision.applied' as const;
export const SUPERVISION_RESTART_LIMIT_EXCEEDED = 'supervision.restart_limit_exceeded' as const;
export const INFRA_FAULT_OBSERVED = 'infra.fault.observed' as const;

/* v0.3.2-workflows — Wave 2 / Workflows sub-team. AgentWorkflow
 * lifecycle events emitted by the operator's AgentWorkflow controller
 * + the workflow runtime. The four states mirror Restate's invocation
 * lifecycle plus an explicit step.completed for each ctx.spawnAgentTask
 * await (audit warehouse can rebuild the workflow's task tree). The
 * `event_subscription_pending` event documents an `event`-trigger
 * subscription that's persisted-but-not-yet-dispatched (Wave 3 wires
 * the dispatcher). */
export const WORKFLOW_STARTED = 'workflow.started' as const;
export const WORKFLOW_STEP_COMPLETED = 'workflow.step.completed' as const;
export const WORKFLOW_COMPLETED = 'workflow.completed' as const;
export const WORKFLOW_FAILED = 'workflow.failed' as const;
export const WORKFLOW_EVENT_SUBSCRIPTION_PENDING = 'workflow.event_subscription_pending' as const;

/* v0.4.2-cache — Wave 3 / Cache sub-team. Per-Agent persistent caches
 * keyed by sha256(template-render). One emission per cache-slot lookup
 * (so an Agent declaring N caches emits N events at admission time).
 * Cache miss is NEVER an error; the event records that the slot was
 * looked up + missed for cache-effectiveness telemetry. See
 * docs/WAVES.md §5.3. */
export const CACHE_HIT = 'cache.hit' as const;
export const CACHE_MISS = 'cache.miss' as const;

/* v0.4.3-identity — Wave 3 / Identity sub-team. SPIFFE/SPIRE per-pod
 * SVID issuance + rotation. `identity.svid_issued` fires when an
 * agent-pod (or workflow-runtime pod) successfully fetched a fresh
 * SVID from the local SPIRE Workload API socket. `identity.rotation`
 * fires when the SPIRE-helper / cert-watcher observes a rotation
 * (cert age delta crosses the rotation threshold). Both are
 * substrate-attributable: we record the SPIFFE ID + the rotation
 * source so SOC2 audit warehouses can join SVID lifecycle to per-task
 * activity. */
export const IDENTITY_SVID_ISSUED = 'identity.svid_issued' as const;
export const IDENTITY_ROTATION = 'identity.rotation' as const;

/* v0.4.4-locality — Wave 3 / Locality sub-team. Three substrate
 * decisions the locality engine emits: a speculative duplicate was
 * spawned for a slow primary (`locality.speculative_spawned`), a
 * loser of the race was marked `superseded`
 * (`locality.speculative_superseded`), and admission deferred a task
 * because pod-pressure (pending agent-pods) crossed the threshold
 * (`admission.pod_pressure_deferred`). */
export const LOCALITY_SPECULATIVE_SPAWNED = 'locality.speculative_spawned' as const;
export const LOCALITY_SPECULATIVE_SUPERSEDED = 'locality.speculative_superseded' as const;
export const ADMISSION_POD_PRESSURE_DEFERRED = 'admission.pod_pressure_deferred' as const;

/* v0.5.0-tenancy — Wave 4 / Tenancy sub-team. Tenant lifecycle +
 * admission-violation + migration-tooling audit events. Catalog grows
 * from 25 → 29. `tenant.created` / `tenant.updated` / `tenant.deleted`
 * track the CR lifecycle (one emission per controller observation);
 * `tenant.admission_violation` fires when an AgentTask creation hits
 * `policy_denied:tenant_namespace_mismatch`; `tenant.migration` fires
 * when the migrate-tenants CLI rewrites Agent + child AgentTask
 * tenant labels. See docs/WAVES.md §6.1. */
export const TENANT_CREATED = 'tenant.created' as const;
export const TENANT_UPDATED = 'tenant.updated' as const;
export const TENANT_DELETED = 'tenant.deleted' as const;
export const TENANT_ADMISSION_VIOLATION = 'tenant.admission_violation' as const;
export const TENANT_MIGRATION = 'tenant.migration' as const;

/* v0.5.1-egress — Wave 4 / Egress sub-team. Per-Agent NetworkPolicy /
 * CiliumNetworkPolicy materialization decisions. */
export const EGRESS_POLICY_APPLIED = 'egress.policy_applied' as const;
export const EGRESS_POLICY_VIOLATION = 'egress.policy_violation' as const;

/* v0.5.2-quotas — Wave 4 / Quotas sub-team. Per-tenant compute /
 * gateway / storage cap audit events. */
export const QUOTA_GATEWAY_INFLIGHT_EXCEEDED = 'quota.gateway_inflight_exceeded' as const;
export const QUOTA_STORAGE_EXCEEDED = 'quota.storage_exceeded' as const;
export const QUOTA_COMPUTE_WARNING = 'quota.compute_warning' as const;
export const QUOTA_RESOURCE_QUOTA_APPLIED = 'quota.resource_quota_applied' as const;

/**
 * Frozen array of every event type. Useful for sanity tests
 * (`expect(ALL_EVENT_TYPES.length).toBe(36)`) and for downstream tools
 * that want to enumerate the event schema (e.g. an OpenAPI generator).
 */
export const ALL_EVENT_TYPES = Object.freeze([
  TASK_ADMITTED,
  TASK_SPAWNED,
  TASK_COMPLETED,
  TASK_FAILED,
  CHILD_SPAWNED,
  CAPABILITY_MINTED,
  CAPABILITY_USED,
  SECRET_ACCESSED,
  QUOTA_BREACHED,
  CONTRACT_VIOLATED,
  SUPERVISION_APPLIED,
  SUPERVISION_RESTART_LIMIT_EXCEEDED,
  INFRA_FAULT_OBSERVED,
  WORKFLOW_STARTED,
  WORKFLOW_STEP_COMPLETED,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  WORKFLOW_EVENT_SUBSCRIPTION_PENDING,
  CACHE_HIT,
  CACHE_MISS,
  IDENTITY_SVID_ISSUED,
  IDENTITY_ROTATION,
  LOCALITY_SPECULATIVE_SPAWNED,
  LOCALITY_SPECULATIVE_SUPERSEDED,
  ADMISSION_POD_PRESSURE_DEFERRED,
  TENANT_CREATED,
  TENANT_UPDATED,
  TENANT_DELETED,
  TENANT_ADMISSION_VIOLATION,
  TENANT_MIGRATION,
  EGRESS_POLICY_APPLIED,
  EGRESS_POLICY_VIOLATION,
  QUOTA_GATEWAY_INFLIGHT_EXCEEDED,
  QUOTA_STORAGE_EXCEEDED,
  QUOTA_COMPUTE_WARNING,
  QUOTA_RESOURCE_QUOTA_APPLIED,
] as const);
