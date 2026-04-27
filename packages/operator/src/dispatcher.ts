/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Dispatcher — abstraction over the A2A bus that carries AgentTask
 * assignments from the operator to agent pods, and completion events
 * back to the operator. Phase 2 ships only the stub impl; Phase 3
 * adds `NatsDispatcher` against the JetStream Helm-deployed cluster
 * (per docs/DESIGN-V0.1.md §4.3).
 *
 * The interface is deliberately small: publish + a future hook for
 * completion subscription. v0.1 reconcile only needs publish — the
 * pod writes its result back to the AgentTask status directly via
 * the K8s API, NOT via this bus. (NATS becomes the optimization for
 * v0.2 once warm-pool latency matters.)
 */

/**
 * Envelope published over the bus. Required + recommended fields per
 * docs/HARNESS-LESSONS.md §6 — the substrate is opinionated about what
 * carries between agents (originating user message + parent
 * distillation are mandatory at the protocol level so sub-agents
 * don't operate on context-stripped task strings).
 */
export interface DispatchedTask {
  /** UID of the AgentTask CRD that triggered this dispatch. */
  readonly taskId: string;
  /** Logical agent identity the task targets — `metadata.name` of an Agent CRD. */
  readonly agentId: string;
  /** Optional parent task UID for delegation chains. */
  readonly parentTaskId?: string;
  /** The verbatim user message that originated this task. Required. */
  readonly originalUserMessage: string;
  /** Optional parent-agent distillation of the request. Recommended. */
  readonly parentDistillation?: string;
  /** Optional list of tool names the operator's prompt requested (F2 input). */
  readonly expectedTools?: readonly string[];
  /** Free-form payload — usually the AgentTask.spec.payload contents. */
  readonly payload: unknown;
}

/**
 * Phase 2: only `publish` is required. Phase 3 adds:
 *
 *   subscribeForCompletion(taskId): Promise<TaskResult>
 *
 * for the operator-side reply pattern. v0.1 sidesteps that by having
 * the agent pod write directly to AgentTask.status via K8s API.
 */
export interface Dispatcher {
  publish(task: DispatchedTask): Promise<void>;
}

/**
 * In-memory dispatcher — accumulates published tasks for inspection.
 * Used by tests and by the operator when running with `--dispatcher=stub`
 * (the v0.1 default until Phase 3 wires `NatsDispatcher`).
 */
export class StubDispatcher implements Dispatcher {
  private readonly _published: DispatchedTask[] = [];

  publish(task: DispatchedTask): Promise<void> {
    this._published.push(task);
    return Promise.resolve();
  }

  /** Read-only view of every task published since construction. */
  get published(): readonly DispatchedTask[] {
    return this._published;
  }

  /** Reset the in-memory log — useful between test cases. */
  clear(): void {
    this._published.length = 0;
  }
}
