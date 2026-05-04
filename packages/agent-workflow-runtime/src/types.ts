/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Public types for `@kagent/agent-workflow-runtime`.
 *
 * The host SDK exposes a small, deterministic surface workflow authors
 * use to coordinate AgentTasks: spawn, wait for outputs, signal a
 * topic, await an external signal, sleep. Each operation lands on
 * Restate's `ctx.run(name, fn)` durable side-effect primitive — once
 * committed, replay returns the persisted result instead of re-issuing
 * the side effect.
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §3.3 (AgentWorkflow)
 *   - docs/WAVES.md §4.3 (sub-team Workflows brief)
 *   - https://docs.restate.dev/develop/typescript/services
 */

import type { CapabilityRef } from '@kagent/capability-types';

/**
 * Reference to an AgentTask the workflow spawned. The substrate's
 * task UID is the durable id; downstream `awaitTask` or `getOutput`
 * calls reference back to it. Identity-stable across replays.
 */
export interface AgentTaskHandle {
  /** UID of the spawned AgentTask CR. Substrate-assigned, replay-stable. */
  readonly taskUid: string;
  /** Namespace the AgentTask landed in. */
  readonly namespace: string;
  /** Stable name of the AgentTask CR. */
  readonly name: string;
}

/**
 * Inputs to `ctx.spawnAgentTask`. Mirrors the substrate's AgentTask
 * shape minus the cap (the runtime forwards the workflow's own cap
 * as `parentCapabilityRef` so admission narrows the child's authority
 * to ⊆ workflow's).
 */
export interface SpawnAgentTaskInput {
  /** Target Agent's `metadata.name`. Mutually exclusive with `targetCapability`. */
  readonly agent?: string;
  /** Capability tag — resolved against the live AgentCapability registry. */
  readonly targetCapability?: string;
  /** Free-form payload the agent loop receives. */
  readonly payload?: unknown;
  /**
   * Bindings for the target Agent's typed inputs (Wave 1 / I/O).
   * Same shape as `AgentTask.spec.inputs[]` from
   * `@kagent/operator/src/crds/types.ts`.
   */
  readonly inputs?: ReadonlyArray<{
    readonly name: string;
    readonly from:
      | { readonly workspace: string }
      | { readonly taskUid: string; readonly output: string }
      | { readonly scalar: unknown };
  }>;
  /** Optional idempotency key. */
  readonly idempotencyKey?: string;
  /**
   * Per-task overrides forwarded to the AgentTask spec.
   * `runConfig.timeoutSeconds` is honored end-to-end.
   */
  readonly runConfig?: {
    readonly tokenLimit?: number;
    readonly costLimitUsd?: number;
    readonly maxIterations?: number;
    readonly timeoutSeconds?: number;
  };
  /**
   * Substrate-opaque metadata threaded onto the AgentTask's labels —
   * the workflow's `name` + `handler` are auto-stamped so trace
   * lineage (workflow → AgentTask) is queryable via `kubectl get
   * agenttasks -l ...`.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Inputs to `ctx.signal` — fire a typed event onto the Wave 3 Events
 * substrate. v0.3.2 STUB: persists the intent in the workflow's run
 * log; the actual NATS publish lands when Wave 3 wires the dispatcher.
 */
export interface SignalInput {
  readonly topic: string;
  readonly payload: unknown;
}

/**
 * Inputs to `ctx.awaitSignal` — durably wait for an external signal
 * matching the topic + (optional) selector. Backed by Restate's
 * awakeable primitive: the workflow handler suspends; an external
 * resolver (NATS message consumer, webhook callback) hits Restate
 * with the awakeable id; the SDK wakes the handler with the payload.
 */
export interface AwaitSignalInput {
  readonly topic: string;
  /** Optional payload-shape selector. v0.3.2 unimplemented; Wave 3 will add. */
  readonly selector?: Readonly<Record<string, unknown>>;
  /**
   * Wall-clock cap on the wait. When elapsed without a signal arrival,
   * the await throws `WorkflowTimeoutError`. Defaults to 24h — long
   * enough for the daily-research pipeline pattern, short enough to
   * surface a stuck workflow during ops review.
   */
  readonly timeoutMs?: number;
}

/**
 * The deterministic operation surface a workflow handler invokes via
 * the `ctx` argument. Every method is durable: replay returns the
 * persisted result rather than re-issuing the underlying effect.
 *
 * Implementations:
 *   - `restateContext(...)` — wraps Restate's `RestateContext` so the
 *     Restate runtime persists each side-effect via `ctx.run()`.
 *   - `inMemoryContext(...)` — vitest harness; records committed
 *     side-effects in a journal and replays them across simulated
 *     crashes (the crash-recovery test depends on this).
 */
export interface WorkflowContext {
  /**
   * Spawn a new AgentTask. Returns the substrate-assigned handle.
   * Replay-stable: the second invocation with the same step name on
   * the same workflow run returns the same handle (Restate journals
   * the task UID at first commit).
   */
  spawnAgentTask(stepName: string, input: SpawnAgentTaskInput): Promise<AgentTaskHandle>;

  /**
   * Wait for an AgentTask spawned earlier in this run to reach a
   * terminal phase. Returns the task's `status.outputs[]` projection
   * on `Completed`; throws `WorkflowTaskFailedError` on `Failed`.
   *
   * Implemented as a Restate awakeable that the operator's reconciler
   * resolves on terminal-status patch (the operator forwards the
   * workflow's awakeable id via the spawned AgentTask's
   * `metadata.annotations`).
   */
  awaitTask(stepName: string, handle: AgentTaskHandle): Promise<AgentTaskOutputs>;

  /**
   * Fire a typed event onto the Events substrate. v0.3.2 stub — the
   * call commits to the run log; Wave 3 lights the actual dispatch.
   */
  signal(stepName: string, input: SignalInput): Promise<void>;

  /**
   * Durably wait for an external signal. Backed by Restate's
   * awakeable. Throws `WorkflowTimeoutError` if `timeoutMs` elapses.
   */
  awaitSignal(stepName: string, input: AwaitSignalInput): Promise<unknown>;

  /**
   * Durable sleep — survives pod crashes. Resolution is per-Restate
   * scheduler (typically ~100ms granularity).
   */
  sleep(stepName: string, ms: number): Promise<void>;

  /**
   * Capability bundle reference of the workflow itself (`<jti>`).
   * Stable across the run; threaded onto every spawnAgentTask as
   * `parentCapabilityRef` so the operator's admission narrows.
   */
  readonly capabilityRef: CapabilityRef | undefined;

  /**
   * Run-wide invocation id (Restate's invocation UID). Used in
   * structured logs + the audit-event correlator so multiple
   * spawnAgentTask calls trace back to one workflow invocation.
   */
  readonly invocationId: string;
}

/**
 * Per-task outputs returned by `awaitTask`. Mirrors the operator's
 * `AgentTask.status.outputs[]` projection (see
 * `@kagent/operator/src/crds/types.ts` `OutputRef`).
 */
export interface AgentTaskOutputs {
  readonly taskUid: string;
  readonly outputs: ReadonlyArray<{
    readonly name: string;
    readonly ref: string;
  }>;
}

/**
 * Throws when `awaitTask` resolves on a `Failed` AgentTask.
 *
 * Carries the operator's terminal `reason` + `error` fields so a
 * workflow can branch on the failure mode (e.g. `verify_failed` vs
 * `policy_denied:capability_violation`).
 */
export class WorkflowTaskFailedError extends Error {
  constructor(
    readonly taskUid: string,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`AgentTask ${taskUid} failed: ${reason} — ${detail}`);
    this.name = 'WorkflowTaskFailedError';
  }
}

/**
 * Throws when `awaitSignal` exceeds its `timeoutMs` cap. Workflows
 * catch this to fall through to a default branch.
 */
export class WorkflowTimeoutError extends Error {
  constructor(
    readonly stepName: string,
    readonly elapsedMs: number,
  ) {
    super(`Workflow step "${stepName}" timed out after ${elapsedMs}ms`);
    this.name = 'WorkflowTimeoutError';
  }
}

/**
 * Inputs to `defineWorkflow` — the public entry point for workflow
 * authors. The `name` is stamped on the registered Restate service;
 * the `run` function is the workflow handler.
 */
export interface DefineWorkflowInput<TInput, TOutput> {
  readonly name: string;
  /**
   * Handler. Receives the user-supplied `input` plus a deterministic
   * `ctx`. Side effects MUST go through `ctx` — direct fetch / db /
   * env mutations are NOT replay-safe.
   */
  run(input: TInput, ctx: WorkflowContext): Promise<TOutput>;
}

/**
 * Output of `defineWorkflow`. The user-supplied workflow image's
 * entrypoint glues the returned definition to Restate's `serve()` —
 * see the README example.
 */
export interface WorkflowDefinition<TInput, TOutput> {
  readonly name: string;
  /**
   * Internal: the runtime exposes the handler so the in-memory test
   * harness + the Restate adapter can both invoke it. Not for
   * consumer code.
   */
  readonly _run: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>;
}
