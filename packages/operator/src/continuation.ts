/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Continuations: a task that stopped before it finished is followed by a
 * new task that resumes its saved conversation (agent-pod checkpoint.ts)
 * instead of the work being lost.
 *
 * Opt-in per Agent: the annotation `kagent.knuteson.io/max-continuations`
 * is how many times one piece of work may be continued (absent or 0 =
 * never). The operator plans a continuation when a task of that Agent
 * ends Failed for a reason more time would fix: its time limit, its
 * iteration cap, or its pod being killed. A model or policy refusal is
 * not continued; the same conversation would meet it again.
 *
 * The continuation is an ordinary AgentTask: the same spec, the same
 * trigger labels (so a schedule's idle gate sees its work still running),
 * a name ending `-cont<n>`, and annotations naming the task it continues
 * and the sha256 of that task's checkpoint as its own status recorded it.
 * The pod loads the checkpoint only when the file matches that digest;
 * without one (the pod died before it could report), the continuation is
 * a fresh run of the same work.
 *
 * v1 continues root tasks only. A child's parent is waiting on that child
 * by uid and has already read its failure.
 */

import type { Agent, AgentTask } from './crds/index.js';

export const MAX_CONTINUATIONS_ANNOTATION = 'kagent.knuteson.io/max-continuations';
export const CONTINUES_UID_ANNOTATION = 'kagent.knuteson.io/continues-uid';
export const CONTINUES_NAME_ANNOTATION = 'kagent.knuteson.io/continues-name';
export const CONTINUES_CHECKSUM_ANNOTATION = 'kagent.knuteson.io/continues-checksum';
export const CONTINUES_REASON_ANNOTATION = 'kagent.knuteson.io/continues-reason';
export const CONTINUATION_INDEX_ANNOTATION = 'kagent.knuteson.io/continuation-index';
/** Must equal `CHECKPOINT_MEDIA_TYPE` in `@kagent/agent-pod` checkpoint.ts. */
export const CHECKPOINT_MEDIA_TYPE = 'application/x-kagent-checkpoint+json';

/** Hard ceiling whatever an Agent's annotation says. */
export const MAX_CONTINUATIONS_CEILING = 5;
/** Only a task that finished this recently is continued, so an informer resync revives nothing old. */
export const CONTINUATION_WINDOW_MS = 3_600_000;

/** Failures more time would fix, by the error text the pod and the failure detector write. */
const RESUMABLE = [
  /^task time limit reached/,
  /reaching maxIterations/,
  /^cancelled: SIGTERM received/,
  /^\[pod\/(PodFailed|DeadlineExceeded)\]/,
];
/** Annotations a continuation inherits; everything else belongs to the earlier task. */
const INHERITED_ANNOTATIONS = ['kagent.knuteson.io/placeholder-cap'];
const NAME_MAX_LEN = 63;

export interface ContinuationManifest {
  readonly apiVersion: string;
  readonly kind: 'AgentTask';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations: Readonly<Record<string, string>>;
  };
  readonly spec: AgentTask['spec'];
}

export type ContinuationPlan =
  | { readonly continuation: ContinuationManifest }
  | { readonly skip: string };

export function maxContinuations(agent: Pick<Agent, 'metadata'>): number {
  const n = Number(agent.metadata.annotations?.[MAX_CONTINUATIONS_ANNOTATION]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_CONTINUATIONS_CEILING) : 0;
}

export function planContinuation(
  task: AgentTask,
  agent: Pick<Agent, 'metadata'>,
  now: Date,
): ContinuationPlan {
  if (task.status?.phase !== 'Failed') return { skip: 'not-failed' };
  const limit = maxContinuations(agent);
  if (limit === 0) return { skip: 'agent-not-opted-in' };
  if (task.spec.parentTask !== undefined) return { skip: 'child-task' };
  const name = task.metadata.name;
  const uid = task.metadata.uid;
  if (name === undefined || uid === undefined) return { skip: 'no-identity' };
  const completedAt = Date.parse(task.status.completedAt ?? '');
  if (Number.isNaN(completedAt) || now.getTime() - completedAt > CONTINUATION_WINDOW_MS) {
    return { skip: 'finished-too-long-ago' };
  }
  const error = task.status.error ?? '';
  if (!RESUMABLE.some((pattern) => pattern.test(error))) return { skip: 'failure-not-resumable' };

  const annotations = task.metadata.annotations ?? {};
  const index = Number(annotations[CONTINUATION_INDEX_ANNOTATION] ?? '0');
  if (!Number.isInteger(index) || index < 0) return { skip: 'bad-continuation-index' };
  if (index >= limit) return { skip: 'continuations-exhausted' };

  const base = name.replace(/-cont\d+$/, '');
  const suffix = `-cont${String(index + 1)}`;
  const nextName = `${base.slice(0, NAME_MAX_LEN - suffix.length)}${suffix}`;

  const checkpoint = (task.status.artifacts ?? []).find(
    (a) => a.mediaType === CHECKPOINT_MEDIA_TYPE && typeof a.checksum === 'string',
  );
  const inherited = Object.fromEntries(
    INHERITED_ANNOTATIONS.flatMap((key) => {
      const value = annotations[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  // An absolute deadline from the first run has passed by now; the continuation gets its own budget.
  const payload = task.spec.payload;
  const spec: AgentTask['spec'] =
    payload !== null && typeof payload === 'object' && 'execution_deadline_at' in payload
      ? {
          ...task.spec,
          payload: Object.fromEntries(
            Object.entries(payload as Record<string, unknown>).filter(
              ([key]) => key !== 'execution_deadline_at',
            ),
          ),
        }
      : task.spec;

  return {
    continuation: {
      apiVersion: task.apiVersion,
      kind: 'AgentTask',
      metadata: {
        name: nextName,
        namespace: task.metadata.namespace ?? 'default',
        labels: { ...(task.metadata.labels ?? {}) },
        annotations: {
          ...inherited,
          [CONTINUES_UID_ANNOTATION]: uid,
          [CONTINUES_NAME_ANNOTATION]: name,
          [CONTINUES_REASON_ANNOTATION]: error.slice(0, 200),
          [CONTINUATION_INDEX_ANNOTATION]: String(index + 1),
          ...(checkpoint?.checksum !== undefined && {
            [CONTINUES_CHECKSUM_ANNOTATION]: checkpoint.checksum,
          }),
        },
      },
      spec,
    },
  };
}

/** Env the agent pod reads to resume (agent-pod runner.ts `KAGENT_CONTINUES_*`). */
export function continuationEnv(
  task: Pick<AgentTask, 'metadata'>,
): readonly { readonly name: string; readonly value: string }[] {
  const annotations = task.metadata.annotations ?? {};
  const uid = annotations[CONTINUES_UID_ANNOTATION];
  if (uid === undefined || uid.length === 0) return [];
  const checksum = annotations[CONTINUES_CHECKSUM_ANNOTATION];
  const reason = annotations[CONTINUES_REASON_ANNOTATION];
  return [
    { name: 'KAGENT_CONTINUES_TASK_UID', value: uid },
    ...(checksum !== undefined ? [{ name: 'KAGENT_CONTINUES_CHECKSUM', value: checksum }] : []),
    ...(reason !== undefined ? [{ name: 'KAGENT_CONTINUES_REASON', value: reason }] : []),
  ];
}
