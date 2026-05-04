/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Task-graph helpers — pure functions for parent/child AgentTask
 * delegation. Implements the Workstream 5 / Phase 5 substrate
 * primitives described in `docs/TASK-GRAPH.md`.
 *
 * Helpers in this module:
 *
 *   - `buildChildTaskManifest`: produce a child AgentTask CR with the
 *     dual ownerRef + label glue the operator's parent re-reconcile
 *     relies on (TASK-GRAPH.md §3 + §5).
 *   - `childRef`: project a child AgentTask down to the compact
 *     ChildRef shape that lives on the parent's `status.children`.
 *   - `aggregateChildren`: fold a list of children into a single
 *     ParentStatusProjection (TASK-GRAPH.md §4 algorithm).
 *   - `parentTaskRefFromChild`: read the labels written by
 *     `buildChildTaskManifest`. Symmetric with `parentTaskRef()` in
 *     `job-watch.ts` for Job/Pod resources.
 *   - `cycleCheck`: walk the parent chain to refuse a child that
 *     would close a cycle (TASK-GRAPH.md §7 open question #2).
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
export const PARENT_TASK_NAME_ANNOTATION = 'kagent.knuteson.io/parent-task-name-full';

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

/**
 * Aggregate phase of a parent over its children. Distinct from the
 * parent's *own* `status.phase` — a parent whose own pod-side work is
 * Completed can still be `PartiallyComplete` over its children.
 *
 * Truth table — see `aggregateChildren` for the reducer:
 *
 *   children                           → aggregatePhase
 *   ----------------------------------- ----------------------
 *   []                                  Pending
 *   all Pending OR all Dispatched OR    Dispatched
 *     mix of Pending+Dispatched
 *   all terminal, none Failed           AllComplete
 *   any Failed                          AnyFailed (overrides all)
 *   some Completed + some in-flight     PartiallyComplete
 */
export type AggregatePhase =
  | 'Pending'
  | 'Dispatched'
  | 'PartiallyComplete'
  | 'AllComplete'
  | 'AnyFailed';

export interface ParentStatusProjection {
  readonly children: readonly ChildRef[];
  readonly aggregatePhase: AggregatePhase;
  readonly successCount: number;
  readonly failureCount: number;
  readonly inFlightCount: number;
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
 * - One required label: `parent-task-uid` (machine-readable, used by
 *   the informer label-selector watch). Short parent names also get
 *   `parent-task-name` as a convenience label for `kubectl get -l ...`;
 *   long parent names live only in an annotation because label values
 *   are capped at 63 characters while resource names can be longer.
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

  // v0.4.1-blackboard — Wave 3 / Blackboard sub-team. Resolve the
  // root-task UID. If the parent itself carries
  // `ROOT_TASK_UID_LABEL`, the parent is a non-root and the child
  // inherits that value. Otherwise the parent IS the root, so its
  // own UID becomes the child's root UID. The label is what the
  // operator's job-spec render path reads to emit
  // KAGENT_BLACKBOARD_BUCKET; every descendant in a tree therefore
  // shares one bucket. Local string constant (mirror of
  // operator/src/job-spec.ts:ROOT_TASK_UID_LABEL) — task-graph.ts is
  // a pure / leaf module that doesn't import job-spec.
  const ROOT_TASK_UID_LABEL = 'kagent.knuteson.io/root-task-uid';
  const parentRootUid = parent.metadata.labels?.[ROOT_TASK_UID_LABEL];
  const childRootUid =
    typeof parentRootUid === 'string' && parentRootUid.length > 0 ? parentRootUid : parentUid;

  const metadata: V1ObjectMeta = {
    name: spec.name,
    namespace: parentNamespace,
    labels: {
      [PARENT_TASK_UID_LABEL]: parentUid,
      ...(isValidLabelValue(parentName) && { [PARENT_TASK_NAME_LABEL]: parentName }),
      [ROOT_TASK_UID_LABEL]: childRootUid,
    },
    annotations: {
      [PARENT_TASK_NAME_ANNOTATION]: parentName,
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
 * aggregateChildren
 * ===================================================================== */

/**
 * Reduce a list of children to a single ParentStatusProjection per the
 * truth table in `AggregatePhase`'s docs. Order-independent; the
 * reducer only counts.
 *
 * Algorithm:
 *
 *   1. Project each child to a ChildRef (bounded shape).
 *   2. Count by terminal class:
 *        - `failureCount`   = children whose phase === 'Failed'
 *        - `successCount`   = children whose phase === 'Completed'
 *        - `inFlightCount`  = everything else (Pending, Dispatched, undefined)
 *   3. Pick aggregatePhase by precedence:
 *        - empty list                   → Pending
 *        - any Failed                   → AnyFailed   (cancellationPolicy=propagate
 *                                                       wants this to fire FAST,
 *                                                       even if siblings still in flight)
 *        - all Completed (no Failed)    → AllComplete
 *        - some Completed + some in-flight → PartiallyComplete
 *        - all in-flight (no terminal)  → Dispatched
 *
 * Note `Dispatched` here is the *aggregate* — covers the case where
 * children are still `Pending` AND/OR `Dispatched`. The "still
 * waiting" predicate the operator uses is `aggregatePhase in
 * {Pending, Dispatched, PartiallyComplete}`.
 */
export function aggregateChildren(children: readonly AgentTask[]): ParentStatusProjection {
  const projected: ChildRef[] = children.map(childRef);
  let successCount = 0;
  let failureCount = 0;
  let inFlightCount = 0;
  for (const ref of projected) {
    if (ref.phase === 'Completed') successCount += 1;
    else if (ref.phase === 'Failed') failureCount += 1;
    else inFlightCount += 1; // Pending, Dispatched, or absent
  }

  let aggregatePhase: AggregatePhase;
  if (projected.length === 0) {
    aggregatePhase = 'Pending';
  } else if (failureCount > 0) {
    aggregatePhase = 'AnyFailed';
  } else if (inFlightCount === 0) {
    // No failures + nothing in flight → everything Completed.
    aggregatePhase = 'AllComplete';
  } else if (successCount > 0) {
    aggregatePhase = 'PartiallyComplete';
  } else {
    aggregatePhase = 'Dispatched';
  }

  return {
    children: projected,
    aggregatePhase,
    successCount,
    failureCount,
    inFlightCount,
  };
}

/* =====================================================================
 * parentTaskRefFromChild
 * ===================================================================== */

/**
 * Read the parent-name + parent-uid + namespace off a child AgentTask.
 * The UID is expected in the `parent-task-uid` label (the only label-
 * keyed informer filter, which is why long parent names — whose names
 * exceed K8s' 63-char label-value cap — still get matched). The name
 * is read from the short-name label when present, then the full-name
 * annotation, then the ownerRef. Returns null when no parent name can
 * be recovered — defensive against AgentTasks that lack any parent-
 * task metadata (i.e. real top-level tasks).
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
  const annotations = child.metadata.annotations ?? {};
  const ownerRef = child.metadata.ownerReferences?.find((ref) => ref.kind === 'AgentTask');
  const name =
    firstNonEmpty(labels[PARENT_TASK_NAME_LABEL], annotations[PARENT_TASK_NAME_ANNOTATION]) ??
    ownerRef?.name;
  const uid = firstNonEmpty(labels[PARENT_TASK_UID_LABEL], ownerRef?.uid);
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

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.length > 0);
}

// Stricter than the K8s spec — the spec allows empty values, but we
// never want to write an empty parent-task-name label. Valid label
// values: ≤63 chars, alphanumeric start/end, alphanumeric + `-_.` in
// between (or a single alphanumeric).
function isValidLabelValue(value: string): boolean {
  return value.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value);
}

/* =====================================================================
 * cycleCheck
 * ===================================================================== */

export type CycleCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cycle: readonly string[] };

/**
 * Walk up the parent chain from `parentUid` to determine whether
 * adopting `candidateChildUid` as a child would close a cycle.
 *
 * Returns `{ ok: false, cycle: [...] }` when `candidateChildUid` is
 * already an ancestor of `parentUid` (the new edge would close a
 * loop). The `cycle` array is the path from `parentUid` upward to
 * `candidateChildUid` inclusive — useful for logging the offending
 * delegation chain.
 *
 * Returns `{ ok: true }` when no cycle is detected, including when
 * the chain terminates at a missing ancestor (`getParent(uid) ===
 * undefined`). A missing ancestor means the chain root has been
 * GC'd or the label is stale — neither is a cycle, so we accept the
 * delegation rather than reject on incomplete data.
 *
 * The walker uses a visited-set internally to bound runtime to
 * O(chain depth) and avoid infinite loops if the existing graph is
 * already corrupt (defense-in-depth — should never happen, but a
 * helper that itself loops on bad input is worse than one that
 * returns early).
 */
export function cycleCheck(
  parentUid: string,
  candidateChildUid: string,
  getParent: (uid: string) => AgentTask | undefined,
): CycleCheckResult {
  // Trivial case — proposing a task as its own child.
  if (parentUid === candidateChildUid) {
    return { ok: false, cycle: [parentUid, candidateChildUid] };
  }

  const visited = new Set<string>();
  const path: string[] = [parentUid];
  let cursor: string | undefined = parentUid;

  while (typeof cursor === 'string' && cursor.length > 0) {
    if (visited.has(cursor)) {
      // Pre-existing loop in the parent chain — not what we were
      // looking for, but bail rather than spin forever. Treat as
      // "no cycle introduced by THIS edge" since the loop existed
      // before; the operator's broader integrity check (a separate
      // concern) would surface it.
      return { ok: true };
    }
    visited.add(cursor);

    const node: AgentTask | undefined = getParent(cursor);
    if (node === undefined) {
      // Chain root — no more ancestors. Candidate is not an ancestor.
      return { ok: true };
    }
    const nextUid: string | undefined = node.spec.parentTask;
    if (typeof nextUid !== 'string' || nextUid.length === 0) {
      // Reached the root of the chain.
      return { ok: true };
    }
    if (nextUid === candidateChildUid) {
      // The candidate child is an ancestor of the parent — cycle.
      path.push(nextUid);
      return { ok: false, cycle: path };
    }
    path.push(nextUid);
    cursor = nextUid;
  }

  return { ok: true };
}
