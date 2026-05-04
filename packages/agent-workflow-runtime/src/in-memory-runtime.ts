/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory deterministic runtime — a faithful Restate analogue for
 * tests + local-dev iteration.
 *
 * Why this exists:
 *
 *   - The crash-recovery test (per docs/WAVES.md §4.3 deliverable 5)
 *     needs to assert "fan out 3 spawns, crash, replay, the same 3
 *     task UIDs come back AND no new tasks are issued". Spinning up
 *     real Restate in CI is heavy (the brief explicitly allows a
 *     unit-level proof).
 *
 *   - Workflow authors iterating locally want to run their
 *     `defineWorkflow(...)` output without a Restate cluster.
 *
 * The semantics this harness preserves (the only ones the rest of
 * the kagent substrate depends on):
 *
 *   1. **Each `ctx.<step>(name, ...)` call is a side effect** keyed
 *      by `(invocationId, stepName)`. The first commit lands the
 *      result in the journal; subsequent calls (e.g. on replay)
 *      read it from the journal without re-executing.
 *
 *   2. **Crash mid-handler**: rejection mid-`run()` is a transparent
 *      replay. Re-invoking `run(input, ctx)` with the same
 *      invocationId hits each committed journal entry and only
 *      re-executes the un-committed tail.
 *
 *   3. **Side-effects are caller-supplied** (constructor injection):
 *      the harness doesn't know how to spawn a real AgentTask; the
 *      caller passes a function that mocks the K8s create-call.
 *      That keeps the harness pure + lets tests count exactly how
 *      many times the underlying side-effect was invoked.
 *
 * What this harness does NOT replicate (out of scope, real Restate
 * does these):
 *
 *   - Distributed durability across pods (the journal lives in process
 *     memory; integration tests with a real Restate cluster cover the
 *     persistence path).
 *   - Cross-handler signal routing across machines.
 *   - Wall-clock timer accuracy under hard backpressure.
 */

import type {
  AgentTaskHandle,
  AgentTaskOutputs,
  AwaitSignalInput,
  SignalInput,
  SpawnAgentTaskInput,
  WorkflowContext,
  WorkflowDefinition,
} from './types.js';
import { WorkflowTaskFailedError, WorkflowTimeoutError } from './types.js';

/* =====================================================================
 * Journal entry shapes — the durable record of each side effect.
 * ===================================================================== */

type JournalEntry =
  | { readonly kind: 'spawn'; readonly stepName: string; readonly handle: AgentTaskHandle }
  | { readonly kind: 'await-task'; readonly stepName: string; readonly outputs: AgentTaskOutputs }
  | {
      readonly kind: 'await-task-failed';
      readonly stepName: string;
      readonly taskUid: string;
      readonly reason: string;
      readonly detail: string;
    }
  | { readonly kind: 'signal'; readonly stepName: string }
  | { readonly kind: 'await-signal'; readonly stepName: string; readonly payload: unknown }
  | {
      readonly kind: 'await-signal-timeout';
      readonly stepName: string;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'sleep'; readonly stepName: string };

/**
 * Caller-supplied side-effect implementations. The harness invokes
 * these on FRESH-execute paths only; replay paths read from the
 * journal. Each fn corresponds to one `ctx.<op>(stepName, ...)` call.
 */
export interface SideEffectFns {
  /** Materialize a real AgentTask. Counted by tests for re-issue check. */
  spawnAgentTask(input: SpawnAgentTaskInput): Promise<AgentTaskHandle>;
  /** Block until the AgentTask reaches a terminal phase. */
  awaitTask(handle: AgentTaskHandle): Promise<AgentTaskOutputs>;
  /** Publish to a Wave 3 Events topic. v0.3.2 stub. */
  signal(input: SignalInput): Promise<void>;
  /**
   * Block until an external matching signal arrives, or `timeoutMs`
   * elapses (then throw WorkflowTimeoutError — caught by the harness
   * + journaled as `await-signal-timeout`).
   */
  awaitSignal(input: AwaitSignalInput): Promise<unknown>;
  /** Time-passes primitive. Real Restate uses durable timers. */
  sleep(ms: number): Promise<void>;
}

/**
 * One workflow invocation's durable state. The harness keeps a map
 * `invocationId → InMemoryRunState`; replay rehydrates from the same
 * state and re-invokes `run()`.
 */
export interface InMemoryRunState {
  readonly invocationId: string;
  /** Append-only log of committed side effects. */
  journal: JournalEntry[];
  /** Set true once `run()` returned (or threw a TerminalError). */
  completed: boolean;
}

/**
 * Crash-recovery harness — drives a `WorkflowDefinition` through
 * `run()` calls; persists a journal that survives "crashes" (test-
 * triggered rejections); re-invokes `run()` with the same
 * invocationId to deterministically replay.
 */
export interface InMemoryRunner<TInput, TOutput> {
  /**
   * Drive a fresh invocation to completion (or `crashAt`). Returns
   * the result OR `{ crashed: true }` when the harness saw the
   * configured crash trigger and aborted.
   */
  start(
    input: TInput,
    opts?: {
      /**
       * Throw an Error mid-execution after this many committed side
       * effects. Used by the crash-recovery test to simulate a pod
       * kill mid-fan-out.
       */
      readonly crashAfterCommits?: number;
      /**
       * Optional explicit invocation id. When unset the runner
       * generates `wf-<random8>` so the test can compare across
       * `start()` + `replay()` calls.
       */
      readonly invocationId?: string;
      /**
       * Cap on the total side-effect commits before the harness
       * forces a `WorkflowTimeoutError`. Defends against runaway
       * loops in test code (tests should finish in O(10) steps).
       */
      readonly maxCommits?: number;
      /**
       * Override for `ctx.capabilityRef`. Defaults to undefined.
       */
      readonly capabilityRef?: string;
    },
  ): Promise<
    | { readonly kind: 'completed'; readonly value: TOutput }
    | { readonly kind: 'crashed'; readonly invocationId: string }
  >;

  /**
   * Replay an invocation that was previously crashed. The journal
   * is reused; only the un-committed tail re-executes.
   */
  replay(
    invocationId: string,
    input: TInput,
    opts?: { readonly capabilityRef?: string; readonly maxCommits?: number },
  ): Promise<TOutput>;

  /**
   * Read the journal of a given invocation. Used by tests to assert
   * "the same N side effects committed; no new ones were issued on
   * replay".
   */
  journal(invocationId: string): readonly JournalEntry[];

  /**
   * Snapshot of the side-effect call counts. Tests assert against
   * these to prove replay does NOT re-issue.
   */
  callCounts(): {
    readonly spawnAgentTask: number;
    readonly awaitTask: number;
    readonly signal: number;
    readonly awaitSignal: number;
    readonly sleep: number;
  };
}

/**
 * Build an in-memory runner around a `WorkflowDefinition`.
 *
 * The harness wraps the caller-supplied `SideEffectFns` in a counter
 * so tests can assert "spawnAgentTask was invoked exactly 3 times
 * across the original run + the replay".
 */
export function createInMemoryRunner<TInput, TOutput>(
  workflow: WorkflowDefinition<TInput, TOutput>,
  sideEffects: SideEffectFns,
): InMemoryRunner<TInput, TOutput> {
  const states = new Map<string, InMemoryRunState>();
  const counts = {
    spawnAgentTask: 0,
    awaitTask: 0,
    signal: 0,
    awaitSignal: 0,
    sleep: 0,
  };

  const buildContext = (
    state: InMemoryRunState,
    capabilityRef: string | undefined,
    crashAfterCommits: number | undefined,
    maxCommits: number,
  ): WorkflowContext => {
    let commitsThisExecution = 0;

    const enforceMaxCommits = (): void => {
      if (state.journal.length > maxCommits) {
        throw new Error(
          `[in-memory-runner] exceeded maxCommits=${maxCommits} (journal has ${state.journal.length} entries)`,
        );
      }
    };

    /**
     * Find an existing journal entry for this step. On replay this
     * returns the persisted result so the side-effect doesn't re-run.
     * Type narrowing is by the caller — the journal stores tagged
     * unions.
     */
    const findEntry = (stepName: string): JournalEntry | undefined => {
      // Steps are uniquely keyed by (invocationId, stepName); workflow
      // authors who reuse a step name across calls are already
      // mis-using the durable contract (Restate would deadlock too).
      // The harness mirrors that strictness.
      return state.journal.find((j) => j.stepName === stepName);
    };

    /**
     * Commit a fresh entry. Bumps `commitsThisExecution`; throws
     * `__crash__` to simulate a pod kill when the configured
     * `crashAfterCommits` boundary is crossed.
     */
    const commit = <T extends JournalEntry>(entry: T): T => {
      state.journal.push(entry);
      commitsThisExecution += 1;
      enforceMaxCommits();
      if (crashAfterCommits !== undefined && commitsThisExecution >= crashAfterCommits) {
        // The error is tagged so the runner's outer catch knows this
        // is the synthetic crash, not a workflow-author bug.
        const err = new Error(
          `[in-memory-runner] simulated crash at ${commitsThisExecution} commits`,
        );
        (err as { __syntheticCrash?: true }).__syntheticCrash = true;
        throw err;
      }
      return entry;
    };

    return {
      capabilityRef,
      invocationId: state.invocationId,
      async spawnAgentTask(stepName, input): Promise<AgentTaskHandle> {
        const existing = findEntry(stepName);
        if (existing !== undefined) {
          if (existing.kind !== 'spawn') {
            throw new Error(
              `[in-memory-runner] step "${stepName}" was previously committed as ${existing.kind}, not spawn`,
            );
          }
          return existing.handle;
        }
        counts.spawnAgentTask += 1;
        const handle = await sideEffects.spawnAgentTask(input);
        commit({ kind: 'spawn', stepName, handle });
        return handle;
      },
      async awaitTask(stepName, handle): Promise<AgentTaskOutputs> {
        const existing = findEntry(stepName);
        if (existing !== undefined) {
          if (existing.kind === 'await-task') return existing.outputs;
          if (existing.kind === 'await-task-failed') {
            throw new WorkflowTaskFailedError(existing.taskUid, existing.reason, existing.detail);
          }
          throw new Error(
            `[in-memory-runner] step "${stepName}" was previously committed as ${existing.kind}, not await-task`,
          );
        }
        counts.awaitTask += 1;
        try {
          const outputs = await sideEffects.awaitTask(handle);
          commit({ kind: 'await-task', stepName, outputs });
          return outputs;
        } catch (err) {
          if (err instanceof WorkflowTaskFailedError) {
            commit({
              kind: 'await-task-failed',
              stepName,
              taskUid: err.taskUid,
              reason: err.reason,
              detail: err.detail,
            });
            throw err;
          }
          throw err;
        }
      },
      async signal(stepName, input): Promise<void> {
        const existing = findEntry(stepName);
        if (existing !== undefined) {
          if (existing.kind !== 'signal') {
            throw new Error(
              `[in-memory-runner] step "${stepName}" was previously committed as ${existing.kind}, not signal`,
            );
          }
          return;
        }
        counts.signal += 1;
        await sideEffects.signal(input);
        commit({ kind: 'signal', stepName });
      },
      async awaitSignal(stepName, input): Promise<unknown> {
        const existing = findEntry(stepName);
        if (existing !== undefined) {
          if (existing.kind === 'await-signal') return existing.payload;
          if (existing.kind === 'await-signal-timeout') {
            throw new WorkflowTimeoutError(stepName, existing.elapsedMs);
          }
          throw new Error(
            `[in-memory-runner] step "${stepName}" was previously committed as ${existing.kind}, not await-signal`,
          );
        }
        counts.awaitSignal += 1;
        try {
          const payload = await sideEffects.awaitSignal(input);
          commit({ kind: 'await-signal', stepName, payload });
          return payload;
        } catch (err) {
          if (err instanceof WorkflowTimeoutError) {
            commit({ kind: 'await-signal-timeout', stepName, elapsedMs: err.elapsedMs });
            throw err;
          }
          throw err;
        }
      },
      async sleep(stepName, ms): Promise<void> {
        const existing = findEntry(stepName);
        if (existing !== undefined) {
          if (existing.kind !== 'sleep') {
            throw new Error(
              `[in-memory-runner] step "${stepName}" was previously committed as ${existing.kind}, not sleep`,
            );
          }
          return;
        }
        counts.sleep += 1;
        await sideEffects.sleep(ms);
        commit({ kind: 'sleep', stepName });
      },
    };
  };

  const drive = async (
    state: InMemoryRunState,
    input: TInput,
    capabilityRef: string | undefined,
    crashAfterCommits: number | undefined,
    maxCommits: number,
  ): Promise<
    | { readonly kind: 'completed'; readonly value: TOutput }
    | { readonly kind: 'crashed'; readonly invocationId: string }
  > => {
    const ctx = buildContext(state, capabilityRef, crashAfterCommits, maxCommits);
    try {
      const value = await workflow._run(input, ctx);
      state.completed = true;
      return { kind: 'completed', value };
    } catch (err) {
      // Synthetic crash: caller asked for it; surface as crashed.
      if (
        err !== null &&
        typeof err === 'object' &&
        (err as { __syntheticCrash?: true }).__syntheticCrash === true
      ) {
        return { kind: 'crashed', invocationId: state.invocationId };
      }
      throw err;
    }
  };

  return {
    async start(input, opts) {
      const invocationId = opts?.invocationId ?? `wf-${randomShortHex()}`;
      const state: InMemoryRunState = {
        invocationId,
        journal: [],
        completed: false,
      };
      states.set(invocationId, state);
      return drive(
        state,
        input,
        opts?.capabilityRef,
        opts?.crashAfterCommits,
        opts?.maxCommits ?? 1024,
      );
    },
    async replay(invocationId, input, opts) {
      const state = states.get(invocationId);
      if (state === undefined) {
        throw new Error(`[in-memory-runner] no journal for invocation "${invocationId}"`);
      }
      if (state.completed) {
        throw new Error(
          `[in-memory-runner] invocation "${invocationId}" already completed; cannot replay`,
        );
      }
      const result = await drive(
        state,
        input,
        opts?.capabilityRef,
        undefined, // no crash on replay
        opts?.maxCommits ?? 1024,
      );
      if (result.kind === 'crashed') {
        // Cannot happen — we passed `undefined` for crashAfterCommits.
        throw new Error('[in-memory-runner] unexpected crash on replay path');
      }
      return result.value;
    },
    journal(invocationId) {
      const state = states.get(invocationId);
      if (state === undefined) {
        throw new Error(`[in-memory-runner] no journal for invocation "${invocationId}"`);
      }
      return state.journal;
    },
    callCounts() {
      return { ...counts };
    },
  };
}

function randomShortHex(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return hex;
}
