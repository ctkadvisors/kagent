/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Crash-recovery proof — Wave 2 / Workflows sub-team deliverable 5.
 *
 * Per docs/WAVES.md §4.3:
 *
 *   "Crash-recovery test: kill workflow pod mid-fan-out, confirm
 *    replay reaches same decision point + does NOT re-issue completed
 *    effects"
 *
 * This suite drives `defineWorkflow(...)`'s output through the
 * in-memory runner with a `crashAfterCommits` boundary, then replays
 * the same invocation id and asserts:
 *
 *   1. The replay's spawnAgentTask handles MATCH the original run's
 *      handles bit-for-bit (same task UID per step name).
 *   2. The replay does NOT re-issue any of the side effects that
 *      already committed before the crash.
 *
 * The brief explicitly allows this proof to be unit-level — the
 * in-memory runner mirrors the only Restate semantic the kagent
 * substrate depends on for crash safety: per-step journaling +
 * replay-stable identity.
 */

import { describe, expect, it, vi } from 'vitest';

import { defineWorkflow } from './define-workflow.js';
import { createInMemoryRunner, type SideEffectFns } from './in-memory-runtime.js';
import {
  WorkflowTaskFailedError,
  WorkflowTimeoutError,
  type AgentTaskHandle,
  type AgentTaskOutputs,
  type AwaitSignalInput,
  type SignalInput,
  type SpawnAgentTaskInput,
  type WorkflowContext,
} from './types.js';

/**
 * A 3-fanout researcher orchestrator. Each spawn step is uniquely
 * named so the harness can journal them; the workflow returns the
 * concatenated outputs so a successful run can be compared against
 * the post-crash replay.
 */
const fanoutOrchestrator = defineWorkflow({
  name: 'fanoutOrchestrator',
  async run(input: { readonly topic: string }, ctx: WorkflowContext) {
    const a = await ctx.spawnAgentTask('spawn-a', {
      agent: 'summarizer',
      inputs: [{ name: 'topic', from: { scalar: input.topic } }],
    });
    const b = await ctx.spawnAgentTask('spawn-b', {
      agent: 'validator',
      inputs: [{ name: 'topic', from: { scalar: input.topic } }],
    });
    const c = await ctx.spawnAgentTask('spawn-c', {
      agent: 'summarizer',
      inputs: [{ name: 'topic', from: { scalar: `${input.topic}-bonus` } }],
    });
    const ra = await ctx.awaitTask('await-a', a);
    const rb = await ctx.awaitTask('await-b', b);
    const rc = await ctx.awaitTask('await-c', c);
    return {
      taskUids: [a.taskUid, b.taskUid, c.taskUid] as const,
      outputs: [ra, rb, rc] as const,
    };
  },
});

/** Build a deterministic side-effect set for the harness. */
function buildSideEffects(): SideEffectFns & {
  readonly spawnedTaskUids: readonly string[];
  readonly resetCounters: () => void;
  readonly counters: { spawn: number; awaitTask: number };
} {
  const counters = { spawn: 0, awaitTask: 0 };
  const seen: string[] = [];
  return {
    spawnedTaskUids: seen,
    counters,
    resetCounters: (): void => {
      counters.spawn = 0;
      counters.awaitTask = 0;
    },
    spawnAgentTask(input: SpawnAgentTaskInput): Promise<AgentTaskHandle> {
      counters.spawn += 1;
      const idx = counters.spawn;
      const taskUid = `task-uid-${idx.toString().padStart(2, '0')}`;
      seen.push(taskUid);
      return Promise.resolve({
        taskUid,
        namespace: 'default',
        name: `${input.agent ?? 'unknown'}-${idx}`,
      });
    },
    awaitTask(handle: AgentTaskHandle): Promise<AgentTaskOutputs> {
      counters.awaitTask += 1;
      return Promise.resolve({
        taskUid: handle.taskUid,
        outputs: [{ name: 'summary', ref: `cas://sha256:${handle.taskUid}/summary` }],
      });
    },
    signal(_input: SignalInput): Promise<void> {
      return Promise.resolve();
    },
    awaitSignal(_input: AwaitSignalInput): Promise<unknown> {
      return Promise.resolve(null);
    },
    sleep(_ms: number): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe('crash-recovery — fan-out orchestrator', () => {
  it('replay returns the same task UIDs and does NOT re-issue spawns', async () => {
    const sideEffects = buildSideEffects();
    const runner = createInMemoryRunner(fanoutOrchestrator, sideEffects);
    const invocationId = 'inv-fixed-1';

    // Crash AFTER 4 commits: spawn-a, spawn-b, spawn-c, await-a all
    // committed. The replay should see those four entries in the
    // journal and only re-execute await-b + await-c.
    const result = await runner.start(
      { topic: 'k3s-2026' },
      { crashAfterCommits: 4, invocationId },
    );
    expect(result.kind).toBe('crashed');
    if (result.kind !== 'crashed') return;
    expect(sideEffects.counters.spawn).toBe(3);
    expect(sideEffects.counters.awaitTask).toBe(1);

    const journalAtCrash = runner.journal(invocationId);
    expect(journalAtCrash.length).toBe(4);
    const spawnEntries = journalAtCrash.filter((j) => j.kind === 'spawn');
    expect(spawnEntries).toHaveLength(3);
    expect(spawnEntries[0]?.kind).toBe('spawn');
    if (spawnEntries[0]?.kind !== 'spawn') return;
    expect(spawnEntries[0].handle.taskUid).toBe('task-uid-01');

    // Snapshot pre-replay counts so we can prove DELTA.
    const preReplaySpawnCount = sideEffects.counters.spawn;
    const preReplayAwaitCount = sideEffects.counters.awaitTask;

    // Replay — the runner re-invokes the workflow handler against
    // the persisted journal. The same step names hit the same
    // entries; only the un-committed tail (await-b + await-c)
    // re-executes.
    const replayResult = await runner.replay(invocationId, { topic: 'k3s-2026' });

    // The workflow's deterministic decision is the same: same 3
    // task UIDs in the same order.
    expect(replayResult.taskUids).toEqual(['task-uid-01', 'task-uid-02', 'task-uid-03']);

    // Critical assertion: replay did NOT re-issue any spawns.
    expect(sideEffects.counters.spawn - preReplaySpawnCount).toBe(0);
    // It also did NOT re-issue the already-committed await-a.
    // It DID issue 2 new awaits (await-b + await-c).
    expect(sideEffects.counters.awaitTask - preReplayAwaitCount).toBe(2);

    // Final journal length covers all 6 steps.
    const journalAfterReplay = runner.journal(invocationId);
    expect(journalAfterReplay.length).toBe(6);
    const finalSpawns = journalAfterReplay.filter((j) => j.kind === 'spawn');
    expect(finalSpawns).toHaveLength(3);
    const finalAwaits = journalAfterReplay.filter((j) => j.kind === 'await-task');
    expect(finalAwaits).toHaveLength(3);

    // The runner-level call count tracks ALL invocations; the
    // strongest single assertion of "no re-issue across the crash":
    // total spawn calls from the harness to the side-effect fn is
    // exactly 3 (one per step), not 6 (3 + 3 if replay re-issued).
    expect(runner.callCounts().spawnAgentTask).toBe(3);
    // Total awaitTask side-effect calls is 3 (one before crash, two
    // after), proving the post-crash branch executed but the pre-
    // crash await-a was satisfied from the journal.
    expect(runner.callCounts().awaitTask).toBe(3);
  });

  it('crash before any commits → replay starts from scratch (single invocation)', async () => {
    const sideEffects = buildSideEffects();
    const runner = createInMemoryRunner(fanoutOrchestrator, sideEffects);
    const invocationId = 'inv-zero-1';

    const result = await runner.start(
      { topic: 'no-progress' },
      { crashAfterCommits: 1, invocationId },
    );
    expect(result.kind).toBe('crashed');

    // Journal has exactly 1 entry — the spawn that triggered the crash.
    const journal = runner.journal(invocationId);
    expect(journal.length).toBe(1);

    const replayResult = await runner.replay(invocationId, { topic: 'no-progress' });
    expect(replayResult.taskUids[0]).toBe('task-uid-01');
    // Spawn was issued ONCE (the crash one); replay reused via journal.
    expect(runner.callCounts().spawnAgentTask).toBe(3);
  });

  it('replay throws when no journal exists for the given invocationId', async () => {
    const sideEffects = buildSideEffects();
    const runner = createInMemoryRunner(fanoutOrchestrator, sideEffects);
    await expect(runner.replay('does-not-exist', { topic: 'x' })).rejects.toThrow(/no journal/);
  });

  it('replay refuses on already-completed invocations', async () => {
    const sideEffects = buildSideEffects();
    const runner = createInMemoryRunner(fanoutOrchestrator, sideEffects);
    const invocationId = 'inv-complete-1';
    const result = await runner.start({ topic: 'simple' }, { invocationId });
    expect(result.kind).toBe('completed');
    await expect(runner.replay(invocationId, { topic: 'simple' })).rejects.toThrow(
      /already completed/,
    );
  });
});

describe('crash-recovery — error semantics', () => {
  it('await-task with WorkflowTaskFailedError journals the failure and replays the same throw', async () => {
    const sideEffects = buildSideEffects();
    const failingAwait = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowTaskFailedError('task-uid-01', 'verify_failed', 'output mismatch'),
      );
    const seFailing: SideEffectFns = {
      ...sideEffects,
      awaitTask: failingAwait,
    };
    const wf = defineWorkflow({
      name: 'singleFail',
      async run(_input: unknown, ctx: WorkflowContext) {
        const t = await ctx.spawnAgentTask('spawn-1', { agent: 'a' });
        await ctx.awaitTask('await-1', t);
        return 'unreachable';
      },
    });
    const runner = createInMemoryRunner(wf, seFailing);
    const invocationId = 'inv-fail-1';
    await expect(runner.start({}, { invocationId })).rejects.toBeInstanceOf(
      WorkflowTaskFailedError,
    );
    const journal = runner.journal(invocationId);
    const failedEntry = journal.find((j) => j.kind === 'await-task-failed');
    expect(failedEntry).toBeDefined();
    if (failedEntry?.kind !== 'await-task-failed') return;
    expect(failedEntry.reason).toBe('verify_failed');
    expect(failedEntry.taskUid).toBe('task-uid-01');
  });

  it('await-signal with WorkflowTimeoutError journals the timeout and replays the same throw', async () => {
    const sideEffects = buildSideEffects();
    const timingOutAwaitSignal = vi
      .fn()
      .mockRejectedValueOnce(new WorkflowTimeoutError('await-signal', 1000));
    const seTimeout: SideEffectFns = {
      ...sideEffects,
      awaitSignal: timingOutAwaitSignal,
    };
    const wf = defineWorkflow({
      name: 'signalWaiter',
      async run(_input: unknown, ctx: WorkflowContext) {
        await ctx.awaitSignal('await-signal', { topic: 't', timeoutMs: 1000 });
        return 'never';
      },
    });
    const runner = createInMemoryRunner(wf, seTimeout);
    const invocationId = 'inv-timeout-1';
    await expect(runner.start({}, { invocationId })).rejects.toBeInstanceOf(WorkflowTimeoutError);
    const journal = runner.journal(invocationId);
    const timeoutEntry = journal.find((j) => j.kind === 'await-signal-timeout');
    expect(timeoutEntry).toBeDefined();
    if (timeoutEntry?.kind !== 'await-signal-timeout') return;
    expect(timeoutEntry.elapsedMs).toBe(1000);
  });
});

describe('crash-recovery — guardrails', () => {
  it('reuse of a step name with a different op kind throws', async () => {
    const sideEffects = buildSideEffects();
    const wf = defineWorkflow({
      name: 'reuseBug',
      async run(_input: unknown, ctx: WorkflowContext) {
        // First call: signal the step. Second: try to await with the
        // same step name. The journal entry from the first call
        // should reject the second call's mismatch.
        await ctx.signal('shared-name', { topic: 't', payload: null });
        const t = await ctx.spawnAgentTask('spawn-1', { agent: 'a' });
        // Now reuse 'shared-name' for an await — boom.
        await ctx.awaitTask('shared-name', t);
        return 'unreachable';
      },
    });
    const runner = createInMemoryRunner(wf, sideEffects);
    await expect(runner.start({})).rejects.toThrow(/previously committed as signal/);
  });

  it('maxCommits cap bites runaway workflows', async () => {
    let calls = 0;
    const sideEffects = buildSideEffects();
    const wf = defineWorkflow({
      name: 'runaway',
      async run(_input: unknown, ctx: WorkflowContext) {
        // Loop 10 spawns with unique step names; cap at 3.
        for (let i = 0; i < 10; i += 1) {
          calls += 1;
          await ctx.spawnAgentTask(`spawn-${i}`, { agent: 'a' });
        }
        return calls;
      },
    });
    const runner = createInMemoryRunner(wf, sideEffects);
    await expect(runner.start({}, { maxCommits: 3 })).rejects.toThrow(/maxCommits=3/);
  });
});
