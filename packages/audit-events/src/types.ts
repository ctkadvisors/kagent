/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CloudEvents v1.0 envelope + per-type data shapes for the kagent
 * substrate audit stream.
 *
 * The substrate emits one event per *substrate decision* — admission,
 * capability mint/use, secret access, spawn, completion, contract
 * violation, quota breach. Every emission goes onto a single NATS
 * JetStream stream named `audit`; downstream consumers (Loki, Splunk,
 * Elastic, ad-hoc reporting) subscribe with whatever filter they like.
 *
 * The envelope conforms to the [CloudEvents v1.0 spec][CE]:
 *
 *   - `specversion: "1.0"` (locked at this value; bump when CE 2.0 lands)
 *   - `id`         — RFC 4122 UUID per emission, never reused
 *   - `type`       — reverse-DNS-ish event-type string, e.g. `task.admitted`
 *   - `source`     — URI-reference identifying the producer
 *                   (`kagent.knuteson.io/operator`,
 *                    `kagent.knuteson.io/agent-pod`, ...)
 *   - `subject`    — opt resource the event is about
 *                   (`AgentTask/<namespace>/<name>`)
 *   - `time`       — RFC 3339 timestamp of the emission
 *   - `datacontenttype: "application/json"` (we always JSON-encode)
 *   - `data`       — typed per-event-type payload (see `AuditEventData`)
 *
 * [CE]: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
 *
 * Why CloudEvents and not bespoke JSON: it's the [SOC2][soc2] /
 * compliance-warehouse lingua franca. Free-tier Loki / Splunk / Elastic
 * connectors all parse it. Audit consumers don't have to learn a
 * kagent-specific schema, just a CE-shaped extension.
 *
 * [soc2]: https://docs.soc2.com/
 */

/**
 * Reverse-DNS-style event-type strings. The substrate emits exactly
 * these — additions are SemVer-minor.
 *
 * Kept as a discriminated-union string literal so a switch() over
 * `event.type` is exhaustive. Adding a member here is the only
 * sanctioned way to add a new event class to the audit stream.
 */
export type AuditEventType =
  | 'task.admitted'
  | 'task.spawned'
  | 'task.completed'
  | 'task.failed'
  | 'child.spawned'
  | 'capability.minted'
  | 'capability.used'
  | 'secret.accessed'
  | 'quota.breached'
  | 'contract.violated'
  /* v0.3.1-supervision — Wave 2 / Supervision sub-team. */
  | 'supervision.applied'
  | 'supervision.restart_limit_exceeded'
  | 'infra.fault.observed'
  /* v0.3.2-workflows — Wave 2 / Workflows sub-team. */
  | 'workflow.started'
  | 'workflow.step.completed'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.event_subscription_pending'
  /* v0.4.2-cache — Wave 3 / Cache sub-team. */
  | 'cache.hit'
  | 'cache.miss'
  /* v0.4.3-identity — Wave 3 / Identity sub-team. */
  | 'identity.svid_issued'
  | 'identity.rotation'
  /* v0.4.4-locality — Wave 3 / Locality sub-team. */
  | 'locality.speculative_spawned'
  | 'locality.speculative_superseded'
  | 'admission.pod_pressure_deferred'
  /* v0.5.0-tenancy — Wave 4 / Tenancy sub-team. */
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.deleted'
  | 'tenant.admission_violation'
  | 'tenant.migration'
  /* v0.5.4-keyrotation — Wave 4 / KeyRotation sub-team. */
  | 'keyrotation.svid_rotated'
  | 'keyrotation.cap_minted_with_ttl'
  | 'keyrotation.gateway_rotated'
  | 'keyrotation.gateway_unsupported';

/**
 * `task.admitted` — operator's admission reconciler accepted an
 * AgentTask onto the substrate (its Job is now un-suspended OR has
 * passed admission control). One emission per accepted task.
 *
 * Wave 0 proof-of-life: this is the FIRST emission point in the
 * substrate. Other emission sites land in subsequent commits by other
 * sub-teams (Caps for `capability.minted`, Isolation for `child.spawned`,
 * etc.) per docs/WAVES.md §2.5.
 */
export interface TaskAdmittedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly model: string | undefined;
  /**
   * Reason the admission decision was reached. Today this is always
   * `'admitted'`; the union exists so future denial paths
   * (`'denied:capacity'`, `'denied:capability_violation'`) can land
   * additively.
   */
  readonly decision: 'admitted';
}

/**
 * `task.spawned` — the operator created a Kubernetes Job for an
 * AgentTask. Distinct from `task.admitted`: admission is the
 * accept/reject decision; spawn is the actual materialization of the
 * Job. (Under admission control most tasks are spawned suspended and
 * un-suspended later; the spawn event records the suspended-create
 * event regardless.)
 *
 * Emitted by: operator/reconcile.ts (other sub-teams will integrate).
 */
export interface TaskSpawnedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly jobName: string;
}

/**
 * `task.completed` — an AgentTask's status patched to `Completed`.
 * Emitted by: agent-pod/runner.ts on success, operator/reconcile.ts as
 * the writer of record.
 */
export interface TaskCompletedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly tokensIn: number | undefined;
  readonly tokensOut: number | undefined;
  readonly costUsd: number | undefined;
}

/**
 * `task.failed` — an AgentTask's status patched to `Failed`.
 * Carries the structured failure cause (per Phase 4 failure-detector
 * output: `Job/<reason>`, `Pod/OOMKilled`, etc.).
 */
export interface TaskFailedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly reason: string;
  readonly message: string;
  /** Distinguishes operator-detected (Job/Pod watcher) vs in-pod failures. */
  readonly source: 'job' | 'pod' | 'agent-pod';
}

/**
 * `child.spawned` — an in-pod `spawn_child_task` tool call created a
 * child AgentTask. Emitted by: agent-pod (Wave 0 Isolation will wire).
 *
 * Distinct from `task.spawned`: child.spawned is from the *parent*
 * agent's perspective, capturing the tree-edge; task.spawned records
 * the substrate's act of creating the Job for whichever task
 * (root-or-child) was admitted.
 */
export interface ChildSpawnedData {
  readonly parentTaskUid: string;
  readonly parentTaskNamespace: string;
  readonly parentTaskName: string;
  readonly childTaskUid: string;
  readonly childTaskName: string;
  readonly childAgentName: string;
  readonly depth: number;
}

/**
 * `capability.minted` — operator's capability-issuer signed a new JWT
 * capability bundle for an AgentTask. Emitted by Wave 2 Caps team
 * (depends on this stream existing per docs/WAVES.md §2.5 critical
 * dependency note).
 */
export interface CapabilityMintedData {
  readonly capabilityId: string;
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly issuer: string;
  readonly expiresAt: string;
  /**
   * Capability claim summary — flattened for audit-warehouse query
   * convenience. Full JWT is in operator etcd; the audit record carries
   * the digest of what authority was granted.
   */
  readonly claims: {
    readonly tools?: readonly string[];
    readonly models?: readonly string[];
    readonly spawn?: readonly string[];
    readonly tenant?: string;
  };
}

/**
 * `capability.used` — an agent-pod presented a capability claim to a
 * substrate gate (spawn, secret-read, model-call) and the gate
 * accepted. Emitted by: agent-pod (Wave 2 Caps).
 */
export interface CapabilityUsedData {
  readonly capabilityId: string;
  readonly taskUid: string;
  readonly claim: string;
  readonly target: string | undefined;
}

/**
 * `secret.accessed` — agent-pod or operator read a Kubernetes Secret
 * material (LiteLLM API key, OTLP headers, Langfuse keys, ...).
 * Emitted by: Wave 0 Secrets sub-team via the secret-injection layer.
 *
 * Records the secret reference (name + key), NEVER the secret value.
 */
export interface SecretAccessedData {
  readonly secretName: string;
  readonly secretKey: string;
  readonly namespace: string;
  readonly accessor: string;
  readonly purpose: string;
}

/**
 * `quota.breached` — the substrate refused an action because a quota
 * cap (org / tenant / agent compute / storage / in-flight) was at or
 * above its limit. Emitted by: Wave 4 Quotas sub-team.
 */
export interface QuotaBreachedData {
  readonly scope: 'org' | 'tenant' | 'agent';
  readonly resource: string;
  readonly limit: number;
  readonly observed: number;
  readonly tenant: string | undefined;
  readonly taskUid: string | undefined;
}

/**
 * `contract.violated` — the substrate caught a contract violation
 * (missing required output, undeclared tool call, unauthorized spawn
 * target). Emitted by: agent-pod (verify_completion) + operator
 * (admission validation). Wave 1+2.
 */
export interface ContractViolatedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly violation: string;
  readonly detail: string;
}

/**
 * `supervision.applied` — Wave 2 / Supervision sub-team. Emitted by
 * the operator each time the supervision strategy engine returns a
 * decision the operator dispatches against an AgentTask tree. One
 * emission per decision (NOT per target).
 *
 * `targets[]` is the in-order list of task UIDs the operator
 * applied the action to. `failedTaskUid` is the trigger.
 */
export interface SupervisionAppliedData {
  readonly parentTaskUid: string | undefined;
  readonly parentTaskNamespace: string;
  readonly parentTaskName: string | undefined;
  readonly agentName: string;
  readonly strategy: 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'escalate';
  readonly action:
    | 'restart'
    | 'terminate-and-restart-tree'
    | 'terminate-and-restart-subset'
    | 'escalate-to-parent';
  readonly failedTaskUid: string;
  readonly failureReason: string;
  readonly targets: readonly string[];
  readonly reason: string;
}

/**
 * `supervision.restart_limit_exceeded` — Wave 2 / Supervision
 * sub-team. Emitted by the operator when supervision would have
 * restarted a task but `restartCount >= Agent.spec.maxRestarts`.
 * The task is marked Failed (`reason: restart_limit_exceeded`)
 * instead of restarted.
 */
export interface SupervisionRestartLimitExceededData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly restartCount: number;
  readonly maxRestarts: number;
}

/**
 * `infra.fault.observed` — Wave 2 / Supervision sub-team.
 * Operator observed an infrastructure-level fault (Job pod
 * OOMKilled, image pull error, NodeNotReady, ...) that does NOT
 * trigger supervision (let K8s Job backoffLimit handle infra).
 * Emitted so operators can spot infra vs application failure modes
 * in audit dashboards.
 */
export interface InfraFaultObservedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  /** Pod / Job source the verdict came from. */
  readonly source: 'job' | 'pod';
  /** Short tag, e.g. `OOMKilled`, `ImagePullBackOff`, `Unschedulable`. */
  readonly reason: string;
  readonly message: string;
}

/**
 * v0.3.2-workflows — AgentWorkflow lifecycle events. Emitted by the
 * AgentWorkflow controller (operator) + the workflow runtime
 * (`@kagent/agent-workflow-runtime`). `workflowName` is the
 * AgentWorkflow CR name; `invocationId` is Restate's per-run UID,
 * stable across replays.
 */
export interface WorkflowStartedData {
  readonly workflowName: string;
  readonly workflowNamespace: string;
  readonly invocationId: string;
  readonly handler: string;
  readonly capabilityId: string | undefined;
}

export interface WorkflowStepCompletedData {
  readonly workflowName: string;
  readonly workflowNamespace: string;
  readonly invocationId: string;
  /** Step name from the workflow's `ctx.<op>(stepName, ...)` call. */
  readonly stepName: string;
  /** One of `spawn | await-task | signal | await-signal | sleep`. */
  readonly stepKind: string;
  /** Substrate-stamped task UID for spawn / await-task steps. */
  readonly taskUid: string | undefined;
}

export interface WorkflowCompletedData {
  readonly workflowName: string;
  readonly workflowNamespace: string;
  readonly invocationId: string;
  /** Total number of journaled side effects on the run. */
  readonly stepCount: number;
}

export interface WorkflowFailedData {
  readonly workflowName: string;
  readonly workflowNamespace: string;
  readonly invocationId: string;
  /** Error category; mirrors WorkflowTaskFailedError.reason / TerminalError class. */
  readonly reason: string;
  readonly message: string;
}

/**
 * `workflow.event_subscription_pending` — emitted at AgentWorkflow
 * reconcile time when an `event`-kind trigger is declared but the
 * Wave 3 Events dispatcher hasn't yet wired the actual NATS
 * subscription. Persists in `AgentWorkflow.status.eventSubscriptions`
 * with `status: 'pending'` until Wave 3 lights it up.
 */
export interface WorkflowEventSubscriptionPendingData {
  readonly workflowName: string;
  readonly workflowNamespace: string;
  readonly topic: string;
}

/**
 * v0.4.2-cache — Wave 3 / Cache sub-team. Per-Agent persistent cache
 * lookup outcome. One emission per declared `Agent.spec.caches[]` slot
 * at AgentTask admission time.
 */
export interface CacheHitData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly slotName: string;
  readonly key: string;
  readonly mountPath: string;
}

/**
 * v0.4.2-cache — same shape as `CacheHitData`. Cache miss is NEVER
 * an error; cold fall-back is the contract.
 */
export interface CacheMissData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly slotName: string;
  readonly key: string;
  readonly mountPath: string;
}

/**
 * v0.4.3-identity — `identity.svid_issued`. Emitted by the operator's
 * Wave 3 / Identity reconciler each time a workload SVID is observed
 * for an agent-pod (or workflow-runtime pod).
 */
export interface IdentitySvidIssuedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly spiffeId: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly source: 'spire-agent' | 'mock';
}

/**
 * v0.4.3-identity — `identity.rotation`. Emitted when the
 * cert-watcher / spiffe-helper observes a fresh SVID replacing an
 * older one for the same SPIFFE ID.
 */
export interface IdentityRotationData {
  readonly spiffeId: string;
  readonly newNotBefore: string;
  readonly newNotAfter: string;
  readonly previousNotAfter: string | undefined;
  readonly gapSeconds: number | undefined;
  readonly source: 'spire-agent' | 'mock';
}

/**
 * `locality.speculative_spawned` — Wave 3 / Locality sub-team.
 */
export interface LocalitySpeculativeSpawnedData {
  readonly primaryTaskUid: string;
  readonly primaryTaskNamespace: string;
  readonly primaryTaskName: string;
  readonly twinTaskName: string;
  readonly agentName: string;
  readonly elapsedMs: number;
  readonly medianMs: number;
  readonly thresholdMs: number;
}

/**
 * `locality.speculative_superseded` — Wave 3 / Locality sub-team.
 */
export interface LocalitySpeculativeSupersededData {
  readonly loserTaskUid: string;
  readonly loserTaskNamespace: string;
  readonly loserTaskName: string;
  readonly winnerTaskUid: string;
  readonly agentName: string;
}

/**
 * `admission.pod_pressure_deferred` — Wave 3 / Locality sub-team.
 */
export interface AdmissionPodPressureDeferredData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly observed: number;
  readonly threshold: number;
}

/**
 * `tenant.created` / `tenant.updated` / `tenant.deleted` — Wave 4 /
 * Tenancy sub-team. The operator's tenant-controller emits one event
 * per Tenant CR transition (add / update / delete). Lifecycle events
 * carry the resolved tenant identity + the operator-observed counts
 * (namespaceCount, agentCount, activeTaskCount) so audit warehouses
 * can plot tenant-scope growth without re-reading the CR.
 */
export interface TenantLifecycleData {
  readonly tenant: string;
  readonly namespaceAllowlist: readonly string[];
  readonly namespaceCount: number;
  readonly agentCount: number;
  readonly activeTaskCount: number;
  /** Tenant CR's `metadata.uid` — stable across rename. */
  readonly tenantUid: string | undefined;
  /** Operator-observed phase at emission time. */
  readonly phase: 'Pending' | 'Ready' | 'Failed';
}

/**
 * `tenant.admission_violation` — emitted when an AgentTask creation
 * fails the per-tenant namespace check (`policy_denied:tenant_namespace_mismatch`).
 * Carries the offending task + tenant + namespace so audit pipelines
 * can correlate the refusal back to the source workload.
 */
export interface TenantAdmissionViolationData {
  readonly tenant: string | undefined;
  readonly taskUid: string | undefined;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string | undefined;
  /** Always `policy_denied:tenant_namespace_mismatch` for v0.5.0. */
  readonly reason: string;
  readonly message: string;
}

/**
 * `tenant.migration` — emitted by the migrate-tenants CLI when an
 * Agent + its in-flight AgentTasks have their tenant labels rewritten
 * from one tenant to another. Records the actor (CLI) for audit
 * forensics + the from/to tenant pair.
 */
export interface TenantMigrationData {
  readonly agentName: string;
  readonly agentNamespace: string;
  readonly fromTenant: string;
  readonly toTenant: string;
  /** Number of in-flight AgentTasks the migration touched. */
  readonly agentTaskCount: number;
  /** Whether the run was a dry-run (no patches applied). */
  readonly dryRun: boolean;
  /** Actor identity — defaults to `cli/migrate-tenants` for the bundled CLI. */
  readonly actor: string;
}

/**
 * v0.5.4-keyrotation — `keyrotation.svid_rotated`. Emitted by the
 * Wave 4 / KeyRotation sub-team's policy controller when the configured
 * rotation interval has been observed crossed for an SVID. Distinct
 * from the underlying `identity.rotation` (which records the
 * SPIRE-observed rotation event itself); this event records the
 * substrate-policy decision that triggered the rotation cycle.
 */
export interface KeyrotationSvidRotatedData {
  readonly spiffeId: string;
  /** Configured interval at the time of the decision (seconds). */
  readonly intervalSeconds: number;
  /** Observed age at the trigger point (seconds since previous notBefore). */
  readonly ageSeconds: number;
  /** Source of the trigger; mirror of identity.ts source enum. */
  readonly source: 'spire-agent' | 'mock';
}

/**
 * v0.5.4-keyrotation — `keyrotation.cap_minted_with_ttl`. Additive
 * companion to `capability.minted`; records the resolved TTL + the
 * policy tier that produced it so compliance dashboards can split
 * "default short-running" vs. "long-running grace" vs. "explicit
 * override" without re-deriving from the cap JWT.
 */
export interface KeyrotationCapMintedWithTtlData {
  readonly capabilityId: string;
  readonly taskUid: string | undefined;
  readonly taskNamespace: string | undefined;
  readonly taskName: string | undefined;
  /** Resolved TTL the cap-issuer applied (seconds). */
  readonly ttlSeconds: number;
  /** One of the policy tiers `cap-ttl.ts` reports. */
  readonly tier: 'short-running' | 'long-running-grace' | 'long-running-clamped';
}

/**
 * v0.5.4-keyrotation — `keyrotation.gateway_rotated`. Successful
 * call into the gateway's `POST /v1/admin/keys/rotate` endpoint. One
 * emission per successful rotation cycle.
 */
export interface KeyrotationGatewayRotatedData {
  /** Gateway base URL (no path / no key material). */
  readonly gatewayUrl: string;
  /** Gateway-supplied rotation id when present (opaque to substrate). */
  readonly rotationId: string | undefined;
  /** Wall-clock time the request returned 2xx (RFC 3339). */
  readonly rotatedAt: string;
}

/**
 * v0.5.4-keyrotation — `keyrotation.gateway_unsupported`. Gateway
 * returned 404 Not Found for the rotation endpoint. Substrate
 * gracefully no-ops; this audit event records the unsupported
 * condition so operators can tell apart "gateway behind on contract"
 * from "rotation fired and succeeded".
 */
export interface KeyrotationGatewayUnsupportedData {
  readonly gatewayUrl: string;
  /** HTTP status the gateway returned (always 404 by contract). */
  readonly status: number;
  /** Wall-clock time the request returned (RFC 3339). */
  readonly observedAt: string;
}

/**
 * Discriminated union of the per-type data shapes. The CloudEvents
 * envelope's `data` field is typed by the corresponding member so a
 * `switch (event.type)` narrows `event.data` without a cast.
 */
export type AuditEventData =
  | { readonly type: 'task.admitted'; readonly data: TaskAdmittedData }
  | { readonly type: 'task.spawned'; readonly data: TaskSpawnedData }
  | { readonly type: 'task.completed'; readonly data: TaskCompletedData }
  | { readonly type: 'task.failed'; readonly data: TaskFailedData }
  | { readonly type: 'child.spawned'; readonly data: ChildSpawnedData }
  | { readonly type: 'capability.minted'; readonly data: CapabilityMintedData }
  | { readonly type: 'capability.used'; readonly data: CapabilityUsedData }
  | { readonly type: 'secret.accessed'; readonly data: SecretAccessedData }
  | { readonly type: 'quota.breached'; readonly data: QuotaBreachedData }
  | { readonly type: 'contract.violated'; readonly data: ContractViolatedData }
  /* v0.3.1-supervision — Wave 2 / Supervision sub-team. */
  | { readonly type: 'supervision.applied'; readonly data: SupervisionAppliedData }
  | {
      readonly type: 'supervision.restart_limit_exceeded';
      readonly data: SupervisionRestartLimitExceededData;
    }
  | { readonly type: 'infra.fault.observed'; readonly data: InfraFaultObservedData }
  /* v0.3.2-workflows — Wave 2 / Workflows sub-team. */
  | { readonly type: 'workflow.started'; readonly data: WorkflowStartedData }
  | { readonly type: 'workflow.step.completed'; readonly data: WorkflowStepCompletedData }
  | { readonly type: 'workflow.completed'; readonly data: WorkflowCompletedData }
  | { readonly type: 'workflow.failed'; readonly data: WorkflowFailedData }
  | {
      readonly type: 'workflow.event_subscription_pending';
      readonly data: WorkflowEventSubscriptionPendingData;
    }
  /* v0.4.2-cache — Wave 3 / Cache sub-team. */
  | { readonly type: 'cache.hit'; readonly data: CacheHitData }
  | { readonly type: 'cache.miss'; readonly data: CacheMissData }
  /* v0.4.3-identity — Wave 3 / Identity sub-team. */
  | { readonly type: 'identity.svid_issued'; readonly data: IdentitySvidIssuedData }
  | { readonly type: 'identity.rotation'; readonly data: IdentityRotationData }
  /* v0.4.4-locality — Wave 3 / Locality sub-team. */
  | {
      readonly type: 'locality.speculative_spawned';
      readonly data: LocalitySpeculativeSpawnedData;
    }
  | {
      readonly type: 'locality.speculative_superseded';
      readonly data: LocalitySpeculativeSupersededData;
    }
  | {
      readonly type: 'admission.pod_pressure_deferred';
      readonly data: AdmissionPodPressureDeferredData;
    }
  /* v0.5.0-tenancy — Wave 4 / Tenancy sub-team. */
  | { readonly type: 'tenant.created'; readonly data: TenantLifecycleData }
  | { readonly type: 'tenant.updated'; readonly data: TenantLifecycleData }
  | { readonly type: 'tenant.deleted'; readonly data: TenantLifecycleData }
  | { readonly type: 'tenant.admission_violation'; readonly data: TenantAdmissionViolationData }
  | { readonly type: 'tenant.migration'; readonly data: TenantMigrationData }
  /* v0.5.4-keyrotation — Wave 4 / KeyRotation sub-team. */
  | { readonly type: 'keyrotation.svid_rotated'; readonly data: KeyrotationSvidRotatedData }
  | {
      readonly type: 'keyrotation.cap_minted_with_ttl';
      readonly data: KeyrotationCapMintedWithTtlData;
    }
  | { readonly type: 'keyrotation.gateway_rotated'; readonly data: KeyrotationGatewayRotatedData }
  | {
      readonly type: 'keyrotation.gateway_unsupported';
      readonly data: KeyrotationGatewayUnsupportedData;
    };

/**
 * CloudEvents v1.0 envelope, locked at `specversion: "1.0"` and
 * `datacontenttype: "application/json"`. The substrate never emits
 * any other content type.
 */
export interface CloudEvent<T = unknown> {
  readonly specversion: '1.0';
  readonly id: string;
  readonly type: AuditEventType;
  readonly source: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: T;
}

/**
 * Strongly-typed CloudEvents envelope: `event.type` and `event.data`
 * align with the discriminated union above, so consumers can
 * `switch (event.type)` and have `event.data` narrowed automatically.
 */
export type AuditEvent = {
  [K in AuditEventData['type']]: CloudEvent<Extract<AuditEventData, { type: K }>['data']> & {
    type: K;
  };
}[AuditEventData['type']];
