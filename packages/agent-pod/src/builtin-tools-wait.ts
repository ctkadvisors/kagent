/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-L — `wait_for_child_task` and `wait_for_children_all` built-in tools.
 *
 * Pairs with WS-K's `spawn_child_task`. After fan-out, the parent
 * agent calls one of these to block until the substrate has the
 * answers it needs:
 *
 *   - wait_for_child_task: block on a single child by uid. Returns
 *     once that task reaches Completed | Failed (terminal phase per
 *     CRD), or `timed_out` cleanly when the wait window expires.
 *   - wait_for_children_all: block until ALL children of the current
 *     task are terminal. Returns the per-child snapshots so the parent
 *     can synthesize.
 *
 * Implementation: polling, NOT Watch (per AGENT-SELF-SERVICE.md §5.2).
 * Same K8sTaskCreator instance the spawn tool already wires.
 *
 * Wall-clock anti-patterns to NOT do (also documented in §5.6):
 *   - fire-and-immediately-wait_all: no parent compute happens between
 *     fan-out and join, so the parent's tokens are wasted.
 *   - wait inside a child: each tier of the tree multiplies remaining
 *     wall-clock; depth budget is the parent's responsibility.
 */

import type { ContentBlock } from '@kagent/agent-loop';
import { defineInProcessTool, InProcessToolProvider } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

import type {
  ChildSnapshot,
  K8sTaskCreator,
  LiveChildSummary,
  ParentIdentity,
} from './k8s-task-creator.js';

/** Default per-call max wait for wait_for_child_task (10 min). */
export const DEFAULT_WAIT_CHILD_TIMEOUT_SECONDS = 600;
/** Default per-call max wait for wait_for_children_all (30 min). */
export const DEFAULT_WAIT_ALL_TIMEOUT_SECONDS = 1_800;
/** Single-child poll cadence — 2s default per AGENT-SELF-SERVICE.md §8 D4. */
export const DEFAULT_WAIT_CHILD_POLL_SECONDS = 2;
/** All-children poll cadence — 5s default (LIST is heavier). */
export const DEFAULT_WAIT_ALL_POLL_SECONDS = 5;

/** Hard floor on per-call timeout (sec) so a 0 doesn't accidentally short-circuit. */
const MIN_TIMEOUT_SECONDS = 1;
/** Hard ceiling — same as runConfig.timeoutSeconds upper bound. */
const MAX_TIMEOUT_SECONDS = 86_400;

/** Hard floor on poll cadence (sec). */
const MIN_POLL_SECONDS = 1;
/** Hard ceiling on poll cadence (sec). */
const MAX_POLL_SECONDS = 60;

export interface WaitToolDeps {
  readonly parent: ParentIdentity;
  readonly k8s: K8sTaskCreator;
  /**
   * Returns the parent task's wall-clock budget in seconds remaining.
   * Used to clamp per-call `timeoutSeconds` so a wait can't outlive
   * the parent's Job activeDeadlineSeconds. Returns `undefined` when
   * the parent has no deadline.
   */
  readonly remainingBudgetSeconds?: () => number | undefined;
  /** Test-injectable sleep. Production: setTimeout-backed. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test-injectable clock. Production: Date.now. */
  readonly now?: () => number;
}

interface WaitChildArgs {
  readonly uid: string;
  readonly timeoutSeconds?: number;
  readonly pollIntervalSeconds?: number;
}

interface WaitAllArgs {
  readonly timeoutSeconds?: number;
  readonly pollIntervalSeconds?: number;
}

/* =====================================================================
 * Tool: wait_for_child_task
 * ===================================================================== */

export function defineWaitForChildTask(deps: WaitToolDeps): InProcessToolDefinition {
  return defineInProcessTool({
    name: 'wait_for_child_task',
    description:
      'Block until the child AgentTask with the given uid reaches a ' +
      'terminal phase (Completed | Failed). Returns ' +
      '{phase, result?, error?, timedOut}. `timedOut: true` when the ' +
      'configured wait window expires before terminal — caller decides ' +
      'whether to retry or proceed without the child. timeoutSeconds ' +
      "is automatically clamped to the parent's remaining budget.",
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: {
        uid: { type: 'string', minLength: 1 },
        timeoutSeconds: {
          type: 'integer',
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
        },
        pollIntervalSeconds: {
          type: 'integer',
          minimum: MIN_POLL_SECONDS,
          maximum: MAX_POLL_SECONDS,
        },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'task-graph', 'wait'],
    handler: async (rawArgs, ctx) => {
      const args = parseWaitChildArgs(rawArgs);
      const timeoutSec = clampToRemaining(
        args.timeoutSeconds ?? DEFAULT_WAIT_CHILD_TIMEOUT_SECONDS,
        deps.remainingBudgetSeconds?.(),
      );
      const pollSec = args.pollIntervalSeconds ?? DEFAULT_WAIT_CHILD_POLL_SECONDS;

      const sleep = deps.sleep ?? defaultSleep;
      const now = deps.now ?? Date.now;
      const deadline = now() + timeoutSec * 1000;

      let last: ChildSnapshot | undefined;
      while (now() < deadline) {
        if (ctx.abortSignal.aborted) {
          throw new Error('wait_for_child_task: aborted');
        }
        const snap = await deps.k8s.getTaskByUid(deps.parent.namespace, args.uid);
        if (snap === undefined) {
          // Child not visible yet — could be informer race after spawn.
          // Keep polling until deadline.
          await sleep(pollSec * 1000);
          continue;
        }
        last = snap;
        if (snap.phase === 'Completed' || snap.phase === 'Failed') {
          return jsonContent({
            phase: snap.phase,
            ...(snap.result !== undefined && { result: snap.result }),
            ...(snap.error !== undefined && { error: snap.error }),
            timedOut: false,
            uid: snap.uid,
            name: snap.name,
            namespace: snap.namespace,
          });
        }
        await sleep(pollSec * 1000);
      }

      return jsonContent({
        phase: last?.phase ?? null,
        timedOut: true,
        waitedSeconds: timeoutSec,
        ...(last?.uid !== undefined && { uid: last.uid }),
        ...(last?.name !== undefined && { name: last.name }),
      });
    },
  });
}

/* =====================================================================
 * Tool: wait_for_children_all
 * ===================================================================== */

export function defineWaitForChildrenAll(deps: WaitToolDeps): InProcessToolDefinition {
  return defineInProcessTool({
    name: 'wait_for_children_all',
    description:
      'Block until ALL children of the current task reach a terminal ' +
      'phase. Returns {aggregatePhase, successCount, failureCount, ' +
      'children: [{uid, name, phase, result?, error?}], timedOut}. ' +
      'aggregatePhase mirrors AgentTask.status.aggregatePhase semantics: ' +
      'AllComplete = every child Completed; AnyFailed = at least one ' +
      'Failed; PartiallyComplete during transitions (only returned ' +
      'when timedOut). Use after fan-out via spawn_child_task; ' +
      'returns immediately with successCount=0 when there are no children.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSeconds: {
          type: 'integer',
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
        },
        pollIntervalSeconds: {
          type: 'integer',
          minimum: MIN_POLL_SECONDS,
          maximum: MAX_POLL_SECONDS,
        },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'task-graph', 'wait'],
    handler: async (rawArgs, ctx) => {
      const args = parseWaitAllArgs(rawArgs);
      const timeoutSec = clampToRemaining(
        args.timeoutSeconds ?? DEFAULT_WAIT_ALL_TIMEOUT_SECONDS,
        deps.remainingBudgetSeconds?.(),
      );
      const pollSec = args.pollIntervalSeconds ?? DEFAULT_WAIT_ALL_POLL_SECONDS;

      const sleep = deps.sleep ?? defaultSleep;
      const now = deps.now ?? Date.now;
      const deadline = now() + timeoutSec * 1000;

      let last: readonly ChildSnapshot[] = [];
      while (now() < deadline) {
        if (ctx.abortSignal.aborted) {
          throw new Error('wait_for_children_all: aborted');
        }
        last = await deps.k8s.listAllChildren(deps.parent);
        if (last.length === 0) {
          return jsonContent({
            aggregatePhase: 'AllComplete',
            successCount: 0,
            failureCount: 0,
            children: [],
            timedOut: false,
          });
        }
        const summary = summarize(last);
        if (summary.inFlight === 0) {
          return jsonContent({
            aggregatePhase: summary.failureCount > 0 ? 'AnyFailed' : 'AllComplete',
            successCount: summary.successCount,
            failureCount: summary.failureCount,
            children: last.map(serializeChild),
            timedOut: false,
          });
        }
        await sleep(pollSec * 1000);
      }

      const summary = summarize(last);
      return jsonContent({
        aggregatePhase: summary.successCount > 0 ? 'PartiallyComplete' : 'Pending',
        successCount: summary.successCount,
        failureCount: summary.failureCount,
        inFlightCount: summary.inFlight,
        children: last.map(serializeChild),
        timedOut: true,
        waitedSeconds: timeoutSec,
      });
    },
  });
}

/* =====================================================================
 * Provider bundle
 * ===================================================================== */

/**
 * Build the bundle of WS-L tools — used by `runner.ts`'s `spawnTools`
 * dep when WS-L is wired alongside WS-K. Returns a single
 * InProcessToolProvider so the runner sees one provider per concern.
 */
export function buildWaitToolProvider(deps: WaitToolDeps): InProcessToolProvider {
  return new InProcessToolProvider({
    id: 'kagent-substrate-wait',
    tools: [defineWaitForChildTask(deps), defineWaitForChildrenAll(deps)],
  });
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function summarize(children: readonly ChildSnapshot[]): {
  successCount: number;
  failureCount: number;
  inFlight: number;
} {
  let successCount = 0;
  let failureCount = 0;
  let inFlight = 0;
  for (const c of children) {
    if (c.phase === 'Completed') successCount++;
    else if (c.phase === 'Failed') failureCount++;
    else inFlight++;
  }
  return { successCount, failureCount, inFlight };
}

function serializeChild(c: ChildSnapshot): {
  uid: string;
  name: string;
  namespace: string;
  phase?: string;
  result?: { content?: string };
  error?: string;
} {
  return {
    uid: c.uid,
    name: c.name,
    namespace: c.namespace,
    ...(c.phase !== undefined && { phase: c.phase }),
    ...(c.result !== undefined && { result: c.result }),
    ...(c.error !== undefined && { error: c.error }),
  };
}

function clampToRemaining(requestedSec: number, remaining: number | undefined): number {
  if (remaining === undefined || !Number.isFinite(remaining)) return requestedSec;
  if (remaining <= 0) return 1;
  return Math.min(requestedSec, Math.max(1, Math.floor(remaining)));
}

function parseWaitChildArgs(raw: Record<string, unknown>): WaitChildArgs {
  const uid = raw.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error('wait_for_child_task: uid is required');
  }
  return {
    uid,
    ...parsePollFields(raw),
  };
}

function parseWaitAllArgs(raw: Record<string, unknown>): WaitAllArgs {
  return parsePollFields(raw);
}

function parsePollFields(raw: Record<string, unknown>): {
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
} {
  const out: { timeoutSeconds?: number; pollIntervalSeconds?: number } = {};
  if (raw.timeoutSeconds !== undefined && raw.timeoutSeconds !== null) {
    if (
      typeof raw.timeoutSeconds !== 'number' ||
      !Number.isInteger(raw.timeoutSeconds) ||
      raw.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
      raw.timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `wait: timeoutSeconds must be an integer in [${String(MIN_TIMEOUT_SECONDS)}, ${String(MAX_TIMEOUT_SECONDS)}]`,
      );
    }
    out.timeoutSeconds = raw.timeoutSeconds;
  }
  if (raw.pollIntervalSeconds !== undefined && raw.pollIntervalSeconds !== null) {
    if (
      typeof raw.pollIntervalSeconds !== 'number' ||
      !Number.isInteger(raw.pollIntervalSeconds) ||
      raw.pollIntervalSeconds < MIN_POLL_SECONDS ||
      raw.pollIntervalSeconds > MAX_POLL_SECONDS
    ) {
      throw new Error(
        `wait: pollIntervalSeconds must be an integer in [${String(MIN_POLL_SECONDS)}, ${String(MAX_POLL_SECONDS)}]`,
      );
    }
    out.pollIntervalSeconds = raw.pollIntervalSeconds;
  }
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/** Re-exports for parity with the spawn provider. */
export { InProcessToolProvider };
export type { LiveChildSummary };
