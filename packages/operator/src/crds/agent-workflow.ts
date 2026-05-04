/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentWorkflow CRD — v0.3.2-workflows (Wave 2 / Workflows sub-team).
 *
 * The substrate's durable orchestrator primitive per
 * docs/SUBSTRATE-V1.md §3.3: a long-running, replayable, side-effect-
 * free decision function that coordinates AgentTasks. Workflow code is
 * deterministic given its event log; on pod crash Restate re-executes
 * the handler from the log + replays already-committed side effects so
 * the workflow lands at the same decision point WITHOUT re-issuing
 * AgentTasks for steps that already completed.
 *
 * The TS types here mirror the YAML CRD schema at
 * `packages/operator/manifests/crds/workspaces.yaml`-style file
 * `packages/operator/manifests/crds/agentworkflows.yaml` (and the
 * chart-shipped copy at
 * `packages/operator/charts/kagent-operator/crds/agentworkflows.yaml`).
 * Keep both in sync — schema drift is caught by
 * `pnpm --filter @kagent/operator crd:check`.
 *
 * Shape principles (parallel to `Agent.spec.capabilityClaims` from Wave
 * 2 Caps):
 *
 *   - `spec.image` + `spec.handler` identify the user-supplied workflow
 *     runtime container; the controller deploys it as a Deployment +
 *     Service + registers it with Restate's admin API.
 *   - `spec.triggers[]` describes WHO can invoke the workflow:
 *     `schedule` (delegates to KagentSchedule from Wave 0 Entry),
 *     `webhook` (delegates to the Wave 0 Entry receiver),
 *     `event` (forward-compat stub for Wave 3 Events).
 *   - `spec.capabilityClaims` (or pre-minted `capabilityRef`) is the
 *     workflow's own capability per docs/SUBSTRATE-V1.md §3.6 — what
 *     authority the workflow's spawned AgentTasks inherit.
 *   - `status.activeRunCount` is operator-owned; the workflow
 *     controller polls Restate's admin API to keep this fresh.
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §3.3 (AgentWorkflow primitive)
 *   - docs/SUBSTRATE-V1.md §3.6 (Capability — workflows carry their own
 *     cap; spawned AgentTasks narrow against it)
 *   - docs/SUBSTRATE-V1.md §3.7 (Event — workflows can be event-
 *     triggered; v0.3.2 ships the schema, Wave 3 wires the dispatcher)
 *   - docs/WAVES.md §4.3 (sub-team Workflows deliverables)
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import type { CapabilityClaims } from '@kagent/capability-types';

import { API_GROUP_VERSION } from './types.js';

/* =====================================================================
 * AgentWorkflow.spec
 * ===================================================================== */

/**
 * Discriminated union of trigger sources. v0.3.2 ships:
 *
 *   - `schedule` — controller materializes a KagentSchedule CR pointing
 *     at the workflow's Restate ingress endpoint. The Wave 0 Entry
 *     KagentSchedule controller does the actual cron wakeups; the
 *     workflow controller is just the wiring.
 *   - `webhook` — controller registers the path with the existing Wave
 *     0 Entry webhook receiver and wires HMAC validation via
 *     `hmacSecretRef`. POSTs that pass HMAC turn into an ingress call
 *     to the workflow handler.
 *   - `event` — v0.3.2 STUB: the schema field is accepted + persisted
 *     in `status.eventSubscriptions` so admission round-trips it; the
 *     actual NATS subject ACL + dispatch logic lands with Wave 3 Events
 *     (`packages/events`). On reconcile the controller emits a
 *     `workflow.event_subscription_pending` audit event so observers
 *     know a wired-but-disabled subscription exists.
 *
 * The `oneOf` shape is enforced at the CRD-YAML level via openAPIV3
 * `oneOf: [schedule, webhook, event]`. The TS surface uses tagged
 * unions so admission + controller code reads cleanly without runtime
 * sniffing.
 */
export interface AgentWorkflowScheduleTrigger {
  readonly kind: 'schedule';
  /** 5-field cron expression, UTC. Same dialect as KagentSchedule.spec.schedule. */
  readonly schedule: string;
}

export interface AgentWorkflowWebhookTrigger {
  readonly kind: 'webhook';
  readonly webhook: {
    /**
     * URL path the receiver matches (no leading slash needed; the
     * controller normalizes). Per-trigger, MUST be unique within the
     * release namespace — the controller refuses duplicates.
     */
    readonly path: string;
    /**
     * Secret reference for the HMAC shared secret. Same shape as the
     * existing `triggers.secrets` Helm value: a Secret in the
     * AgentWorkflow's namespace, with `key` naming the data field.
     */
    readonly hmacSecretRef: {
      readonly name: string;
      readonly key: string;
    };
  };
}

export interface AgentWorkflowEventTrigger {
  readonly kind: 'event';
  readonly event: {
    /** NATS subject the workflow subscribes to (Wave 3-defined). */
    readonly topic: string;
    /**
     * JSON-Schema (or a forward-compat opaque object) describing the
     * payload shape. v0.3.2 STUB — the controller persists the value
     * verbatim and emits a `workflow.event_subscription_pending` audit
     * event; the actual subscription dispatch lands in Wave 3.
     */
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export type AgentWorkflowTrigger =
  | AgentWorkflowScheduleTrigger
  | AgentWorkflowWebhookTrigger
  | AgentWorkflowEventTrigger;

export interface AgentWorkflowSpec {
  /**
   * OCI image of the workflow runtime container. The container's
   * entrypoint MUST `import` the user's workflow module and call
   * `defineWorkflow(...).serve()` (from `@kagent/agent-workflow-runtime`)
   * to register the handler with Restate. The controller deploys this
   * image as a 1-replica Deployment by default; `spec.replicas` raises
   * the cap if higher availability is desired.
   */
  readonly image: string;

  /**
   * Exported handler name to invoke per trigger fire. Mirrors the
   * `name` argument to `defineWorkflow`. The controller passes this
   * verbatim to Restate's admin API as the registered service name —
   * Restate itself is the dispatch authority once the workflow image
   * is registered.
   */
  readonly handler: string;

  /**
   * Trigger sources. Each entry is a discriminated union (`kind`).
   * Empty / unset = no triggers; the workflow is invocable only via
   * direct Restate ingress (operator + smoke tests).
   */
  readonly triggers?: readonly AgentWorkflowTrigger[];

  /**
   * Pre-minted capability bundle reference (`<jti>`). When set, the
   * controller does NOT mint a new bundle — it forwards the existing
   * one to the workflow's Deployment via Secret-volume. Use this only
   * for advanced scenarios (e.g. cross-tenant share); production
   * workflows should leave this unset and let the controller mint at
   * Reconcile time from `capabilityClaims`.
   */
  readonly capabilityRef?: string;

  /**
   * Capability claims this workflow is permitted to mint into a JWT
   * bundle for any AgentTasks it spawns. Same shape + glob dialect as
   * `Agent.spec.capabilityClaims` (per `@kagent/capability-types`):
   * `tools / models / spawn / read / write / egress / tenant /
   * publish / subscribe`.
   *
   * Mutually exclusive (preferred path) with `capabilityRef`. When
   * both are unset, the controller mints an EMPTY bundle — the
   * workflow can run, but any spawn attempt admission-fails with
   * `policy_denied:capability_violation`.
   */
  readonly capabilityClaims?: CapabilityClaims;

  /**
   * Number of workflow runtime pods. Defaults to 1 — Restate handles
   * replay across replica failures, so HA is opportunistic, not
   * required. Bump to 2+ when invocation throughput exceeds one pod's
   * capacity.
   */
  readonly replicas?: number;

  /**
   * Override the cluster Restate address the workflow runtime registers
   * with. Defaults to the chart-managed in-cluster Restate Service URL
   * (`KAGENT_WORKFLOWS_RESTATE_ADDRESS` on the operator deployment).
   * Useful only for advanced multi-Restate setups.
   */
  readonly restateAddress?: string;
}

/* =====================================================================
 * AgentWorkflow.status
 * ===================================================================== */

export type AgentWorkflowPhase = 'Pending' | 'Ready' | 'Failed';

/**
 * Standard Kubernetes condition pattern. Mirrors `WorkspaceCondition`
 * but kept distinct (different domain — different condition `type`
 * vocabularies).
 *
 * Known condition types emitted by the AgentWorkflow controller:
 *
 *   - `RestateRegistered`     — admin POST /deployments succeeded
 *   - `DeploymentReady`       — workflow runtime Deployment has
 *                               minAvailable replicas
 *   - `Ready`                 — RestateRegistered + DeploymentReady
 *   - `Failed`                — controller hit an unrecoverable error;
 *                               cause in `message`
 *   - `EventSubscriptionPending` — `event` trigger schema accepted,
 *                                  Wave 3 dispatcher not yet wired
 */
export interface AgentWorkflowCondition {
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime: string;
  readonly observedGeneration?: number;
}

export interface AgentWorkflowStatus {
  /**
   * Lifecycle phase. `Pending` until the workflow image is deployed
   * AND registered with Restate; `Ready` once both succeed; `Failed`
   * if either step fails irrecoverably.
   */
  readonly phase?: AgentWorkflowPhase;
  /**
   * `metadata.generation` the operator most recently reconciled.
   * Standard Kubernetes pattern.
   */
  readonly observedGeneration?: number;
  /**
   * RFC 3339 timestamp of the most recent reconcile that touched the
   * workflow's Deployment + Restate registration. Useful for
   * forensics: cross-reference with operator logs to find the
   * triggering event.
   */
  readonly lastTickAt?: string;
  /**
   * Number of in-flight workflow invocations the controller most
   * recently saw via Restate's admin API. Best-effort — may lag
   * reality by up to one polling interval.
   */
  readonly activeRunCount?: number;
  /**
   * Append-only list of discrete conditions. The controller writes
   * `RestateRegistered`, `DeploymentReady`, `Ready`, `Failed`,
   * `EventSubscriptionPending`.
   */
  readonly conditions?: readonly AgentWorkflowCondition[];
  /**
   * Capability bundle reference the controller minted for this
   * workflow at Reconcile time. Stamped on the workflow's runtime
   * Deployment via Secret-volume + threaded into every spawned
   * AgentTask as `parentCapabilityRef`.
   *
   * Operator-owned; the workflow runtime never writes this.
   */
  readonly capabilityRef?: string;
  /**
   * Persisted summary of `event`-kind triggers. v0.3.2 STUB — the
   * controller writes one entry per `event` trigger so observers see
   * the wired-but-pending state until Wave 3 lights up the dispatcher.
   */
  readonly eventSubscriptions?: readonly {
    readonly topic: string;
    readonly status: 'pending' | 'subscribed' | 'failed';
    readonly message?: string;
  }[];
}

/* =====================================================================
 * AgentWorkflow top-level CR
 * ===================================================================== */

export interface AgentWorkflow {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentWorkflow';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentWorkflowSpec;
  readonly status?: AgentWorkflowStatus;
}

/* =====================================================================
 * Type guard
 * ===================================================================== */

export function isAgentWorkflow(obj: unknown): obj is AgentWorkflow {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'AgentWorkflow') return false;
  const spec = o.spec as { image?: unknown; handler?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (typeof spec.image !== 'string' || spec.image.length === 0) return false;
  if (typeof spec.handler !== 'string' || spec.handler.length === 0) return false;
  return true;
}

/* =====================================================================
 * Trigger predicates — narrow `AgentWorkflowTrigger` at compile time.
 * ===================================================================== */

export function isScheduleTrigger(t: AgentWorkflowTrigger): t is AgentWorkflowScheduleTrigger {
  return t.kind === 'schedule';
}

export function isWebhookTrigger(t: AgentWorkflowTrigger): t is AgentWorkflowWebhookTrigger {
  return t.kind === 'webhook';
}

export function isEventTrigger(t: AgentWorkflowTrigger): t is AgentWorkflowEventTrigger {
  return t.kind === 'event';
}

/* =====================================================================
 * Status helpers — readiness predicates for the operator's reconciler.
 * ===================================================================== */

/**
 * Whether the workflow is fully ready (both Restate registration AND
 * the runtime Deployment have come up). The controller gates trigger
 * activation on this — a `schedule`-triggered workflow's
 * KagentSchedule CR isn't created until the workflow is Ready.
 */
export function isAgentWorkflowReady(wf: AgentWorkflow): boolean {
  if (wf.status === undefined) return false;
  return wf.status.phase === 'Ready';
}

/**
 * Whether the workflow is in a terminal-bad phase. Used by admission
 * to fail-fast incoming trigger calls when the underlying workflow is
 * Failed.
 */
export function isAgentWorkflowFailed(wf: AgentWorkflow): boolean {
  return wf.status?.phase === 'Failed';
}

/**
 * Stable Deployment name derived from the AgentWorkflow's name. 1:1
 * mapping by convention — helps with `kubectl get deploy -l ...`
 * grep workflows. Documented on the controller's status patch.
 */
export function deploymentNameForAgentWorkflow(wf: AgentWorkflow): string {
  const name = wf.metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('AgentWorkflow is missing metadata.name — cannot derive Deployment name');
  }
  return `kawf-${name}`;
}

/**
 * Stable Service name derived from the AgentWorkflow's name. The
 * Service fronts the workflow runtime's HTTP/2 endpoint that Restate's
 * dispatcher pushes invocations to.
 */
export function serviceNameForAgentWorkflow(wf: AgentWorkflow): string {
  return deploymentNameForAgentWorkflow(wf);
}
