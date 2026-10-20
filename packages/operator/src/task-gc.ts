/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Finished-AgentTask retention.
 *
 * Nothing deleted an AgentTask once it finished, so the informer the whole
 * operator runs on grew with every run: 3,181 tasks (12 MB) on 2026-10-20,
 * re-listed on every resync, and the 256Mi operator OOMed on its first list.
 * On an interval this deletes Completed/Failed tasks that finished longer than
 * the retention window ago, except:
 *
 *   - a task whose template candidate still awaits review (the catalog reads
 *     it until a review decision lands),
 *   - a child task (any ownerReference): its parent's deletion cascades it, and
 *   - an undecided task the review queue flags (verifier failed, suspicious
 *     detector, review requested): it is evidence, kept for the separate
 *     `flaggedRetentionMs`, or for good when that is unset.
 *
 * CAS blobs are unaffected: cas-gc already roots only non-Completed tasks.
 * Off unless `KAGENT_TASK_RETENTION` is set; dry-run logs what it would delete.
 */

import type { AgentTask } from './crds/index.js';
import { MIN_RETENTION_MS } from './cas-gc.js';

const CANDIDATE = 'kagent.knuteson.io/template-candidate';
const DECIDED = 'kagent.knuteson.io/review-decision';
const REQUESTED = 'kagent.knuteson.io/review-requested';

export interface TaskGcConfig {
  readonly retentionMs: number;
  /** Undecided flagged tasks (see `flagged`); undefined keeps them. */
  readonly flaggedRetentionMs?: number;
  readonly intervalMs: number;
  readonly dryRun?: boolean;
}

export interface TaskGcDeps {
  readonly listAgentTasks: () => readonly AgentTask[];
  readonly deleteAgentTask: (namespace: string, name: string) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** When a finished task finished; undefined while it can still run. */
export function finishedAtMs(task: AgentTask): number | undefined {
  const phase = task.status?.phase;
  if (phase !== 'Completed' && phase !== 'Failed') return undefined;
  // completedAt is absent on tasks that failed before running; creation is the floor.
  const raw = task.status?.completedAt ?? task.metadata.creationTimestamp;
  const at = raw === undefined ? Number.NaN : new Date(raw).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** The review queue's own flags (workbench classifyTask), minus candidates. */
export function flagged(task: AgentTask): boolean {
  const status = (task.status ?? {}) as {
    verification?: { passed?: boolean };
    structuralVerdict?: { suspicious?: readonly string[] };
  };
  return (
    status.verification?.passed === false ||
    (status.structuralVerdict?.suspicious ?? []).length > 0 ||
    task.metadata.annotations?.[REQUESTED] === 'true'
  );
}

export function shouldDeleteTask(
  task: AgentTask,
  nowMs: number,
  retentionMs: number,
  flaggedRetentionMs?: number,
): boolean {
  const finished = finishedAtMs(task);
  if (finished === undefined || nowMs - finished < retentionMs) return false;
  if ((task.metadata.ownerReferences ?? []).length > 0) return false;
  const annotations = task.metadata.annotations ?? {};
  if (annotations[DECIDED] !== undefined) return true;
  if (annotations[CANDIDATE] !== undefined) return false;
  if (!flagged(task)) return true;
  return flaggedRetentionMs !== undefined && nowMs - finished >= flaggedRetentionMs;
}

export async function runOnce(
  config: TaskGcConfig,
  deps: TaskGcDeps,
): Promise<{ scanned: number; eligible: number; deleted: number }> {
  const log = deps.log ?? ((m) => console.log(m));
  const now = (deps.now ?? Date.now)();
  const tasks = deps.listAgentTasks();
  const eligible = tasks.filter((t) =>
    shouldDeleteTask(t, now, config.retentionMs, config.flaggedRetentionMs),
  );
  let deleted = 0;
  if (config.dryRun !== true) {
    for (const task of eligible) {
      try {
        await deps.deleteAgentTask(task.metadata.namespace ?? 'default', task.metadata.name ?? '');
        deleted += 1;
      } catch (err) {
        // Already gone or forbidden: the next sweep sees the live list again.
        log(`[kagent-operator/task-gc] delete ${task.metadata.name ?? '?'} failed: ${String(err)}`);
      }
    }
  }
  log(
    `[kagent-operator/task-gc] scanned=${String(tasks.length)} eligible=${String(eligible.length)} ` +
      `deleted=${String(deleted)}${config.dryRun === true ? ' (dry-run)' : ''}`,
  );
  return { scanned: tasks.length, eligible: eligible.length, deleted };
}

export function startTaskGc(config: TaskGcConfig, deps: TaskGcDeps): { stop(): void } {
  if (config.retentionMs < MIN_RETENTION_MS || config.intervalMs < MIN_RETENTION_MS) {
    throw new Error('task-gc: retention and interval must each be >= 1 minute');
  }
  const log = deps.log ?? ((m) => console.log(m));
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    runOnce(config, deps)
      .catch((err: unknown) => {
        log(`[kagent-operator/task-gc] sweep failed: ${String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick(); // the backlog is the reason this exists: clear it at boot, not an interval later
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
