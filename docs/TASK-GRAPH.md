# Durable Task Graph

**Date:** 2026-04-26
**Phase:** 5 (substrate primitive — parent/child AgentTask delegation)
**Status:** Design draft, pre-implementation
**License of described code:** MIT

> Read [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) for v0.1 architecture and
> [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) for the failure modes
> that motivate the envelope contract this builds on.

---

## 1. Motivation

Phase 4 shipped the single-task path: `AgentTask` → operator informer →
Job → agent-pod → status patch. The envelope already carries
`parentTaskId` (Phase 3, locked in by `envelope.test.ts`), so any agent
loop *can* spawn a child by `kubectl apply`-ing a new `AgentTask` with
`spec.parentTask` set to its own UID. What is missing is everything that
makes that delegation **durable**, **observable**, and **cancellable**
without pod-to-pod RPC:

- The parent has no first-class way to discover its children. Today it
  would have to `LIST agenttasks` with a custom label, which works but
  is a convention every consumer would re-invent.
- The parent agent has no obvious way to *wait* for a child without
  blocking inside its loop (anti-pattern for batch Jobs that the
  operator GCs after 1h).
- Cancellation only works one-way today (delete child → child Job GC's
  via ownerRef). Deleting a parent does not cascade because Jobs own
  Pods, but `AgentTask` does not own its child `AgentTask`s.
- Retries are inconsistent: `Job.spec.backoffLimit = 0` (per
  `job-spec.ts`) means the operator owns retry policy in principle, but
  no field captures attempt count, so it cannot.

These are **substrate primitives**, not workflow features. We are NOT
building a DAG engine, swarm scheduler, or plan-then-execute topology —
those remain application-layer (per `CLAUDE.md` "what this repo does
NOT do"). We are giving consumers the kernel-level affordances they
would otherwise paper over with conventions and bash.

## 2. Schema additions (additive, no renames)

All additions are optional fields under existing schemas. No breaking
change. Lifecycle work in `reconcile.ts` is touching adjacent surface
concurrently; this design proposes the diff but does not edit
`crds/types.ts` (zero-merge-friction posture).

### 2.1 `AgentTask.spec` additions

```yaml
# packages/operator/charts/kagent-operator/crds/agenttask.yaml
spec:
  properties:
    # ... existing fields unchanged ...
    maxRetries:
      type: integer
      minimum: 0
      maximum: 10
      default: 0
      description: |
        Operator-level retry budget. On a failed Job (terminal-failed
        state observed by the Phase 4.x Job watcher), the operator
        increments status.retryCount and re-creates the Job with a
        suffixed name when retryCount < maxRetries. The agent-pod
        Job's own backoffLimit stays at 0 — retry is owned at the
        AgentTask layer so each attempt is a discrete, traced run
        with its own podName.
    cancellationPolicy:
      type: string
      enum: [propagate, isolate]
      default: propagate
      description: |
        propagate (default): when this task transitions to Failed or
        is deleted, all children are cancelled too. isolate: children
        outlive the parent (rare; useful for fire-and-forget fan-out).
```

### 2.2 `AgentTask.status` additions

```yaml
status:
  properties:
    # ... existing fields unchanged ...
    children:
      type: array
      description: |
        Child tasks this task spawned. Operator maintains the list by
        watching for AgentTasks that carry spec.parentTask = this
        task's UID. The list is a *projection* of the canonical truth
        (the OwnerReference + label on each child); duplicating it
        here makes parent reconcile O(1) and gives `kubectl get` a
        readable surface.
      items:
        type: object
        required: [taskUid, taskName]
        properties:
          taskUid: { type: string }
          taskName: { type: string }
          phase:
            type: string
            enum: [Pending, Dispatched, Completed, Failed, Cancelled]
          completedAt: { type: string, format: date-time }
    childrenSummary:
      type: object
      description: |
        Aggregate counter view, refreshed each reconcile. Source of
        truth for "is this parent done waiting?" without iterating
        the children array.
      properties:
        total:    { type: integer, minimum: 0 }
        pending:  { type: integer, minimum: 0 }
        running:  { type: integer, minimum: 0 } # Dispatched
        succeeded:{ type: integer, minimum: 0 }
        failed:   { type: integer, minimum: 0 }
        cancelled:{ type: integer, minimum: 0 }
    retryCount:
      type: integer
      minimum: 0
      description: 'Number of attempts so far. 0 on first dispatch.'
    cancellationRequestedAt:
      type: string
      format: date-time
      description: |
        Set by the operator when this task is cascade-cancelled by a
        parent, or by a future `kubectl kagent cancel` CLI. The agent
        pod has no in-pod NATS subscription in v0.1, so it cannot
        observe this directly — the operator deletes the underlying
        Job after setting this field. v0.2 will surface it via NATS
        for graceful shutdown.
```

A new terminal phase `Cancelled` joins `{Pending, Dispatched, Completed,
Failed}`. Existing reconcile logic skips terminal phases; `Cancelled`
slots into that set without touching the skip predicate.

## 3. Reconcile strategy — how the parent waits

**Decision: ownerRef + label-selector watcher, NOT a NATS subscription
for the parent.**

The parent agent-pod does NOT wait inside its loop. It returns from its
own loop the moment it dispatches children, then exits — its Job
terminates normally and the operator GCs the Pod. The "wait" is
relocated to the operator's reconciler:

1. When a child `AgentTask` is created with `spec.parentTask = <uid>`,
   the operator stamps it with two pieces of glue:
   - `metadata.ownerReferences[0]` = `{kind: AgentTask, uid: <parent uid>}`
     (controller: false, blockOwnerDeletion: false — see §5).
   - `metadata.labels["kagent.knuteson.io/parent-task-uid"] = <parent uid>`.
2. The existing `makeInformer` watch on `AgentTask` (cluster-wide) fires
   on every status transition. The reconciler reads the changed task,
   notices `spec.parentTask` is set, and **enqueues a reconcile of the
   parent** by parent UID.
3. The parent's reconcile re-projects `status.children` and
   `status.childrenSummary` from a `LIST agenttasks
   --label-selector=kagent.knuteson.io/parent-task-uid=<parent uid>`.
4. If the summary shows all children are terminal AND the parent's own
   pod-side work is `Completed`, the parent stays `Completed` (no-op).
   If any child is `Failed` and `cancellationPolicy=propagate`, the
   parent transitions to `Failed` with `error: "child <uid> failed"`
   and cascade-cancels remaining non-terminal children.

**Why ownerRef-driven informer instead of NATS:**

- Reuses the K8s watch loop that already exists. NATS-for-parent-wait
  would require an in-pod NATS subscription, which `ROADMAP.md` Phase
  4.x explicitly defers to v0.2 ("In-pod NATS subscription —
  **deferred**").
- Survives operator restart. NATS subjects are ephemeral; etcd is the
  source of truth. After a crash the informer's resync re-walks every
  AgentTask and the projection rebuilds itself — no replay logic needed.
- One mechanism for both async-wait and cascade-delete (next §). NATS
  would be a parallel control plane.
- Dead-simple to test: `reconcile.test.ts` already mocks
  `customApi.list*`; child enumeration drops into the same harness.

**Latency cost:** parent re-reconcile fires on the child's status
transitions, gated by informer event delivery (~tens of ms on a healthy
K3s). Acceptable — the use case is multi-second LLM calls, not
microsecond pipelines.

## 4. Status aggregation — when is a parent "done"?

A parent has a derived terminal state only when **both** conditions
hold:

- The parent's *own* agent-pod work has set `status.phase` to a
  terminal value (`Completed` or `Failed`), AND
- Every entry in `status.children` is terminal
  (`Completed | Failed | Cancelled`).

Algorithm (operator-side, runs on parent reconcile):

```
def aggregate(parent):
    children = LIST agenttasks WHERE label parent-task-uid == parent.uid
    summary  = count_by_phase(children)
    parent.status.children        = project(children)
    parent.status.childrenSummary = summary

    own_done = parent.status.phase in {Completed, Failed}
    kids_done = (summary.total
                 == summary.succeeded + summary.failed + summary.cancelled)
    if not (own_done and kids_done):
        return  # still waiting — informer will re-fire

    if parent.status.phase == Completed and summary.failed == 0:
        # already correct, nothing to patch
        return
    if summary.failed > 0 and parent.spec.cancellationPolicy == 'propagate':
        patch_status(parent, phase=Failed,
                     error=f"{summary.failed} child task(s) failed")
        cascade_cancel(non_terminal_children)
```

Example — parent with 3 children:

```yaml
status:
  phase: Completed
  result: { ... agent's own answer ... }
  children:
    - { taskUid: c1, taskName: t1-c1, phase: Completed, completedAt: ... }
    - { taskUid: c2, taskName: t1-c2, phase: Completed, completedAt: ... }
    - { taskUid: c3, taskName: t1-c3, phase: Failed,    completedAt: ... }
  childrenSummary: { total: 3, pending: 0, running: 0,
                     succeeded: 2, failed: 1, cancelled: 0 }
```

Under `cancellationPolicy: propagate` (default), this parent would have
flipped to `Failed` the moment c3 failed; the example above shows the
`isolate` case where the parent's own work succeeded and one child
failed independently.

## 5. Cancellation semantics

**OwnerRef cascade for the Job, but NOT controller-mode for the parent
AgentTask relationship.**

- The Job continues to set `controller: true, blockOwnerDeletion: true`
  pointing at its AgentTask (existing `job-spec.ts` behavior). Deleting
  an AgentTask still GC's its Job + Pod. Unchanged.
- The child AgentTask sets `controller: false` on its parent-AgentTask
  ownerRef. Reason: K8s only allows one controller-owner; the Job is
  already the controller of the Pod, and we want `controller: true` on
  the Job → AgentTask link to keep Job lifecycle clean. The
  parent-AgentTask → child-AgentTask link is a *non-controller* owner
  ref — K8s GC still cascade-deletes children when the parent is
  deleted, just without the "blocks deletion" semantics.
- `cancellationPolicy: propagate` (the default) layers operator-driven
  semantic cancellation on top of GC: a parent transitioning to Failed
  causes the operator to set `status.cancellationRequestedAt` on each
  non-terminal child, then delete the child's Job (which GCs the Pod).
  The child's reconcile then patches `status.phase=Cancelled`.
- `cancellationPolicy: isolate` skips the cascade — useful for
  fire-and-forget fan-out where the parent only needed to launch
  children, not coordinate them.

The agent-pod does not observe `cancellationRequestedAt` in v0.1 (no
in-pod NATS subscription). Cancellation is hard-stop via Job deletion.
v0.2 will add a graceful path via NATS `agent.<id>.control.cancel`.

## 6. Retry counting

**At AgentTask level. `Job.spec.backoffLimit` stays 0.**

`status.retryCount` increments when the Phase 4.x Job watcher observes
a terminal-failed Job AND `spec.maxRetries > status.retryCount`. The
operator then:

1. Patches `status.phase` back to `Pending` and increments
   `retryCount`.
2. Deletes the failed Job (TTL would also handle this, but we want the
   slot freed immediately).
3. Lets the next reconcile create a fresh Job with name
   `kat-<uid>-r<N>` (r0 omitted for backward compat with the existing
   `jobNameForTask`).

Reasoning: each retry should produce a discrete Pod with its own
`podName`, its own Langfuse trace, its own `structuralVerdict`. Using
Job-level `backoffLimit > 0` would replay inside the same Job and lose
that separation. The substrate's observability contract demands one
attempt = one trace.

## 7. Open questions

1. **Should `status.children` cap at N entries to bound etcd object
   size?** A fan-out of 100 children blows up parent CR size. Proposal:
   cap projection at 50, surface `childrenSummary.total` truthfully,
   and add `status.childrenTruncated: true`. Decide by Phase 5
   start.
2. **Cycle detection.** A child cannot create a task with
   `parentTask = its own ancestor`. CRD admission webhook is overkill
   for v0.1. Proposal: reconcile rejects with `Failed` if it walks
   the parent chain and sees its own UID. Cheap, correct.
3. **`cancellationRequestedAt` graceful handling.** v0.1 hard-stops via
   Job deletion. Is there a v0.1 workload that *needs* graceful (e.g.
   flush pending Langfuse spans)? If yes, accept a small race where
   the trace is incomplete; if no, defer entirely to v0.2.
4. **Retry backoff.** `maxRetries` is a count, not a schedule. Phase 5
   ships immediate retry. Exponential backoff between attempts is a
   reasonable v0.2 add (`spec.retryBackoffSeconds`).

---

## Appendix A — Proposed TS shape for `packages/operator/src/crds/types.ts`

> **DO NOT EDIT `types.ts` from this design.** Lifecycle work is in
> flight on the same file. Land this diff as part of Phase 5's first
> commit, after the lifecycle PR merges.

```ts
// Add to AgentTaskPhase union:
export type AgentTaskPhase =
  | 'Pending'
  | 'Dispatched'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'; // NEW — see TASK-GRAPH.md §2.2

export type CancellationPolicy = 'propagate' | 'isolate';

export interface ChildTaskRef {
  readonly taskUid: string;
  readonly taskName: string;
  readonly phase?: AgentTaskPhase;
  readonly completedAt?: string;
}

export interface ChildrenSummary {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

// Extend AgentTaskSpec with:
export interface AgentTaskSpec {
  // ... existing fields unchanged ...

  /**
   * Operator-level retry budget. Job-level backoffLimit stays at 0;
   * the operator re-creates a fresh Job per retry so each attempt is
   * a discrete trace. See TASK-GRAPH.md §6.
   */
  readonly maxRetries?: number;

  /**
   * Default 'propagate' — parent failure cascade-cancels children.
   * 'isolate' for fire-and-forget fan-out. See TASK-GRAPH.md §5.
   */
  readonly cancellationPolicy?: CancellationPolicy;
}

// Extend AgentTaskStatus with:
export interface AgentTaskStatus {
  // ... existing fields unchanged ...

  /**
   * Projection of child AgentTasks (LIST by parent-task-uid label).
   * Maintained by the parent's reconciler on every child status event.
   * Capped — see TASK-GRAPH.md open question #1.
   */
  readonly children?: readonly ChildTaskRef[];

  /** Aggregate counter view — source of truth for "parent done?" */
  readonly childrenSummary?: ChildrenSummary;

  /** Truncation flag if children was capped. */
  readonly childrenTruncated?: boolean;

  /** Operator-incremented attempt counter. 0 on first dispatch. */
  readonly retryCount?: number;

  /** Cascade-cancellation marker. v0.1 hard-stop; v0.2 graceful. */
  readonly cancellationRequestedAt?: string;
}
```

### Conventional commit shapes (when this lands — DO NOT commit now)

- `feat(phase-5-task-graph): extend AgentTask CRD with children + retry surface`
- `feat(phase-5-task-graph): parent re-reconcile on child status transitions`
- `feat(phase-5-task-graph): cascade cancellation via cancellationPolicy=propagate`
- `test(phase-5-task-graph): aggregation algorithm + cycle detection`
