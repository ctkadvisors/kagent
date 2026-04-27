/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Task-graph helpers — pure functions for parent/child AgentTask
 * delegation. Implements the Workstream 5 / Phase 5 substrate
 * primitives described in `docs/TASK-GRAPH.md`.
 *
 * This first slice ships the manifest builder + small projection
 * helpers:
 *
 *   - `buildChildTaskManifest`: produce a child AgentTask CR with the
 *     dual ownerRef + label glue the operator's parent re-reconcile
 *     relies on (TASK-GRAPH.md §3 + §5).
 *   - `childRef`: project a child AgentTask down to the compact
 *     ChildRef shape that lives on the parent's `status.children`.
 *   - `parentTaskRefFromChild`: read the labels written by
 *     `buildChildTaskManifest`. Symmetric with `parentTaskRef()` in
 *     `job-watch.ts` for Job/Pod resources.
 *
 * The aggregateChildren reducer + cycleCheck land in the next commit.
 *
 * IMPORTANT: this module is pure. No K8s clients, no informers, no
 * NATS. Wire-up (operator re-reconciles parent on child status change,
 * parent.status.children gets populated) is a later slice. Keeping
 * the helpers behavior-free means they can be exercised by the
 * Workbench API and a future child-creating tool without dragging in
 * the operator's runtime deps.
 */

import type { V1ObjectMeta, V1OwnerReference } from '@kubernetes/client-node';

import {
  API_GROUP_VERSION,
  type AgentTask,
  type AgentTaskPhase,
  type AgentTaskSpec,
} from './crds/index.js';

/* =====================================================================
 * Label constants — shared with operator wire-up code in the next slice.
 * Symmetric naming with the existing `kagent.knuteson.io/task` label
 * (see `job-watch.ts`); these labels live on child AgentTask CRs so
 * the operator can list children by parent UID in O(1).
 * ===================================================================== */

export const PARENT_TASK_UID_LABEL = 'kagent.knuteson.io/parent-task-uid';
export const PARENT_TASK_NAME_LABEL = 'kagent.knuteson.io/parent-task-name';

/* =====================================================================
 * Types
 * ===================================================================== */

/**
 * Caller-supplied description of a child task to spawn under a parent.
 * Mirrors the slice of `AgentTaskSpec` the parent agent actually
 * controls — namespace, ownerRefs, and labels are derived from the
 * parent and applied by `buildChildTaskManifest`.
 */
export interface ChildTaskSpec {
  /** Child AgentTask `metadata.name`. Must be unique within namespace. */
  readonly name: string;
  /** Namespace — typically inherited from the parent (verified inside builder). */
  readonly namespace: string;
  /** Mutually exclusive with `targetCapability`. */
  readonly targetAgent?: string;
  /** Mutually exclusive with `targetAgent`. */
  readonly targetCapability?: string;
  /**
   * Originating user message — required at the protocol level so a
   * child agent can never be context-stripped (HARNESS-LESSONS §4).
   * Always pass it down explicitly; the operator's own copy-from-parent
   * fallback is a defensive backstop, not the contract.
   */
  readonly originalUserMessage: string;
  /** Optional parent-agent distillation of the user's intent. Recommended. */
  readonly parentDistillation?: string;
  /** Optional list of tool category names the parent expects the child to fire. */
  readonly expectedTools?: readonly string[];
  /** Substrate-opaque payload. */
  readonly payload: unknown;
  /** Soft time limit. Operator does not enforce; agent loop honors via RunBudget. */
  readonly timeoutSeconds?: number;
}

/**
 * Compact projection of a child AgentTask suitable for placement on
 * the parent's `status.children`. Omits substrate-opaque payload + spec
 * to bound parent CR size.
 */
export interface ChildRef {
  readonly name: string;
  readonly namespace: string;
  /** Populated once K8s assigns a UID at creation. */
  readonly uid?: string;
  /** Mirrors `AgentTaskPhase`; absent until the child is reconciled. */
  readonly phase?: AgentTaskPhase;
  readonly completedAt?: string;
  readonly error?: string;
}

/* =====================================================================
 * buildChildTaskManifest
 * ===================================================================== */

/**
 * Produce a `kagent.knuteson.io/v1alpha1` AgentTask CR ready to apply
 * via `customApi.createNamespacedCustomObject`. Validates the oneOf
 * targetAgent/targetCapability invariant in code (the CRD enforces it
 * at admission too) so callers fail fast at build time.
 *
 * Glue applied by this builder:
 *
 * - `metadata.namespace` inherits from the parent (children must live
 *   beside their parent for the operator's namespaced reconcile to
 *   find them).
 * - Two labels: `parent-task-uid` (machine-readable, used by the
 *   informer label-selector watch) and `parent-task-name` (human-
 *   readable for `kubectl get -l ...`).
 * - One owner reference back to the parent AgentTask, with
 *   `controller: false` so it does not collide with the Job's
 *   `controller: true` ownerRef on the child (TASK-GRAPH.md §5
 *   "Split owner-ref semantics"). `blockOwnerDeletion: true` so etcd
 *   GC of the parent waits for children to acknowledge.
 * - `spec.parentTask = parent.metadata.uid` (the existing field —
 *   carries forward through the dispatch envelope to the child agent
 *   loop unchanged).
 *
 * Throws if the parent lacks `metadata.uid` (cannot link without it),
 * or if `ChildTaskSpec` violates the targetAgent/targetCapability
 * oneOf invariant.
 */
export function buildChildTaskManifest(parent: AgentTask, spec: ChildTaskSpec): AgentTask {
  const parentUid = parent.metadata.uid;
  if (typeof parentUid !== 'string' || parentUid.length === 0) {
    throw new Error('parent AgentTask is missing metadata.uid — cannot build child manifest');
  }
  const parentName = parent.metadata.name;
  if (typeof parentName !== 'string' || parentName.length === 0) {
    throw new Error('parent AgentTask is missing metadata.name — cannot build child manifest');
  }

  // oneOf enforcement — defensive duplicate of the CRD's `oneOf`
  // schema. Callers see the friendly error here; the API server's 422
  // is opaque from inside agent-pod code.
  const hasAgent = typeof spec.targetAgent === 'string' && spec.targetAgent.length > 0;
  const hasCapability =
    typeof spec.targetCapability === 'string' && spec.targetCapability.length > 0;
  if (hasAgent && hasCapability) {
    throw new Error(
      'ChildTaskSpec must set exactly one of {targetAgent, targetCapability}, not both',
    );
  }
  if (!hasAgent && !hasCapability) {
    throw new Error('ChildTaskSpec must set exactly one of {targetAgent, targetCapability}');
  }

  const parentNamespace = parent.metadata.namespace ?? 'default';
  if (spec.namespace !== parentNamespace) {
    throw new Error(
      `child namespace '${spec.namespace}' must equal parent namespace '${parentNamespace}'`,
    );
  }

  const ownerRef: V1OwnerReference = {
    apiVersion: parent.apiVersion,
    kind: parent.kind,
    name: parentName,
    uid: parentUid,
    // NON-controller — the Job for this child task is its controller-owner
    // (see job-spec.ts). K8s only allows one controller per resource.
    controller: false,
    // Cascade-delete still applies (non-controller ownerRefs participate
    // in GC); blockOwnerDeletion=true keeps parent deletion honest until
    // the API server has finalized the child.
    blockOwnerDeletion: true,
  };

  const metadata: V1ObjectMeta = {
    name: spec.name,
    namespace: parentNamespace,
    labels: {
      [PARENT_TASK_UID_LABEL]: parentUid,
      [PARENT_TASK_NAME_LABEL]: parentName,
    },
    ownerReferences: [ownerRef],
  };

  // Build the spec defensively — only emit oneOf branch + optional
  // fields when the caller actually set them. Avoids ambiguous
  // undefined keys round-tripping through JSON serializers.
  const childSpec: AgentTaskSpec = {
    ...(hasAgent && { targetAgent: spec.targetAgent }),
    ...(hasCapability && { targetCapability: spec.targetCapability }),
    payload: spec.payload,
    parentTask: parentUid,
    originalUserMessage: spec.originalUserMessage,
    ...(spec.parentDistillation !== undefined && {
      parentDistillation: spec.parentDistillation,
    }),
    ...(spec.expectedTools !== undefined && { expectedTools: spec.expectedTools }),
    ...(spec.timeoutSeconds !== undefined && { timeoutSeconds: spec.timeoutSeconds }),
  };

  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata,
    spec: childSpec,
  };
}

/* =====================================================================
 * childRef
 * ===================================================================== */

/**
 * Project a child AgentTask down to its parent-status entry. Pulls the
 * uid + phase + completedAt + error into the bounded `ChildRef` shape.
 * Caller is responsible for filtering — every child returned by a
 * `LIST agenttasks --label-selector=parent-task-uid=<uid>` should
 * round-trip through this function.
 */
export function childRef(child: AgentTask): ChildRef {
  const name = child.metadata.name ?? '';
  const namespace = child.metadata.namespace ?? '';
  return {
    name,
    namespace,
    ...(child.metadata.uid !== undefined && { uid: child.metadata.uid }),
    ...(child.status?.phase !== undefined && { phase: child.status.phase }),
    ...(child.status?.completedAt !== undefined && { completedAt: child.status.completedAt }),
    ...(child.status?.error !== undefined && { error: child.status.error }),
  };
}

/* =====================================================================
 * parentTaskRefFromChild
 * ===================================================================== */

/**
 * Read the parent-name + parent-uid + namespace off a child AgentTask's
 * labels. Returns null when the labels are missing — defensive against
 * AgentTasks created out-of-band that happen to satisfy a list filter
 * but were not produced by `buildChildTaskManifest`.
 *
 * Symmetric with `parentTaskRef()` in `job-watch.ts` (which reads the
 * `kagent.knuteson.io/task` label off Job/Pod resources to find the
 * AgentTask). Here we read parent-task labels off a child AgentTask
 * to find its parent.
 */
export function parentTaskRefFromChild(
  child: AgentTask,
): { name: string; namespace: string; uid?: string } | null {
  const labels = child.metadata.labels ?? {};
  const name = labels[PARENT_TASK_NAME_LABEL];
  const uid = labels[PARENT_TASK_UID_LABEL];
  // Namespace comes from the child itself — children inherit parent
  // namespace per `buildChildTaskManifest`, so the child's own
  // namespace IS the parent's namespace.
  const namespace = child.metadata.namespace;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof namespace !== 'string' || namespace.length === 0) return null;
  return {
    name,
    namespace,
    ...(typeof uid === 'string' && uid.length > 0 && { uid }),
  };
}
