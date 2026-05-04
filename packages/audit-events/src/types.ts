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
  | 'infra.fault.observed';

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
  | { readonly type: 'infra.fault.observed'; readonly data: InfraFaultObservedData };

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
