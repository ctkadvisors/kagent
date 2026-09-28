/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * When is a namespace idle enough for a `whenIdle` schedule to fire?
 *
 * Before: any AgentTask in phase Pending or Dispatched made the namespace
 * busy. A task's phase reads Pending from creation until its terminal
 * write, including the whole time it runs, so one legitimate four-hour
 * inventor run held every idle schedule for four hours (2026-09-28
 * 12:10-16:03Z), and a task abandoned in Pending would have held them
 * forever.
 *
 * Now, from the tasks and their Jobs:
 *   - busy: a live task is waiting for admission (no Job yet, or its Job
 *     is suspended). Running work is already bounded by admission's
 *     per-model cap; a queue means that cap is full, so starting more
 *     would only lengthen it.
 *   - abandoned: a non-terminal task older than its own timeout plus
 *     ABANDON_GRACE_SECONDS never blocks anything; it is reported.
 *   - a schedule's own previous task still live (queued or running) keeps
 *     that schedule from firing again (CronJob concurrencyPolicy Forbid),
 *     so one schedule cannot pile copies of itself onto the Spark.
 *   - quiet: measured from the newest completion or the newest live task's
 *     creation, whichever is later.
 */

export const DEFAULT_TIMEOUT_SECONDS = 1800;
/** Past its own timeout by this much, a non-terminal task is abandoned. */
export const ABANDON_GRACE_SECONDS = 900;
export const TRIGGER_NAME_LABEL = 'kagent.knuteson.io/trigger-name';
export const TASK_LABEL = 'kagent.knuteson.io/task';

export interface TaskView {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec?: {
    readonly timeoutSeconds?: number;
    readonly runConfig?: { readonly timeoutSeconds?: number };
  };
  readonly status?: { readonly phase?: string; readonly completedAt?: string };
}

export interface JobView {
  readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: { readonly suspend?: boolean };
  readonly status?: {
    readonly active?: number;
    readonly succeeded?: number;
    readonly failed?: number;
  };
}

export interface NamespaceIdleAssessment {
  /** undefined while a live task waits for admission. */
  readonly idleSince: Date | undefined;
  /** Schedules (trigger names) whose own task is still live. */
  readonly activeSchedules: ReadonlySet<string>;
  /** Non-terminal tasks past their deadline: ignored, for the log. */
  readonly abandoned: readonly string[];
}

const TERMINAL = new Set(['Completed', 'Failed']);

function ms(stamp: string | undefined): number {
  const t = Date.parse(stamp ?? '');
  return Number.isFinite(t) ? t : NaN;
}

export function assessNamespaceIdle(
  tasks: readonly TaskView[],
  jobs: readonly JobView[],
  now: Date,
): NamespaceIdleAssessment {
  const jobByTask = new Map<string, JobView>();
  for (const job of jobs) {
    const task = job.metadata?.labels?.[TASK_LABEL];
    if (task !== undefined) jobByTask.set(task, job);
  }
  let newest = 0;
  let queued = false;
  const activeSchedules = new Set<string>();
  const abandoned: string[] = [];
  for (const task of tasks) {
    const name = task.metadata?.name ?? '';
    const created = ms(task.metadata?.creationTimestamp);
    if (TERMINAL.has(task.status?.phase ?? '')) {
      const done = ms(task.status?.completedAt);
      const at = Number.isFinite(done) ? done : created;
      if (Number.isFinite(at) && at > newest) newest = at;
      continue;
    }
    const timeout =
      task.spec?.runConfig?.timeoutSeconds ?? task.spec?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (
      Number.isFinite(created) &&
      now.getTime() - created > (timeout + ABANDON_GRACE_SECONDS) * 1000
    ) {
      abandoned.push(name);
      continue;
    }
    if (Number.isFinite(created) && created > newest) newest = created;
    const schedule = task.metadata?.labels?.[TRIGGER_NAME_LABEL];
    if (schedule !== undefined) activeSchedules.add(schedule);
    const job = jobByTask.get(name);
    const finished = (job?.status?.succeeded ?? 0) > 0 || (job?.status?.failed ?? 0) > 0;
    if (!finished && (job === undefined || job.spec?.suspend === true)) queued = true;
  }
  return { idleSince: queued ? undefined : new Date(newest), activeSchedules, abandoned };
}
