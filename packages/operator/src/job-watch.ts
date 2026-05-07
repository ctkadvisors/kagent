/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Job + Pod watcher — surfaces terminal Kubernetes failures back into
 * `AgentTask.status.phase=Failed` so a crashed pod doesn't silently
 * leave its task stuck in `Dispatched`.
 *
 * The AgentTask informer (watch.ts) handles the AgentTask CR side. The
 * happy-path status writeback lives in the agent-pod (status.ts). This
 * module covers the unhappy paths the agent-pod can't report on its
 * own: image pull failures, OOMKills before status patch, scheduling
 * failures, container config errors.
 *
 * Namespace-scoped by default via the operator chart, label-selected to
 * only see resources the operator manages
 * (`kagent.knuteson.io/managed-by=kagent-operator`). Advanced installs
 * can pass no namespace for a cluster-wide watch.
 */

import {
  type CoreV1Api,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type V1Job,
  type V1JobList,
  type V1Pod,
  makeInformer,
} from '@kubernetes/client-node';

import {
  type RestartOptions,
  type RestartTimer,
  type InformerRestartLogger,
  createRestarter,
} from './informer-restart.js';

const MANAGED_BY_LABEL = 'kagent.knuteson.io/managed-by=kagent-operator';
const TASK_LABEL = 'kagent.knuteson.io/task';

/** Per-event handler invoked by the informers. */
export interface JobPodHandler {
  /**
   * A Job tied to one of our AgentTasks changed. Implementations should
   * look up the parent AgentTask via the `kagent.knuteson.io/task`
   * label, classify failure via `failure-detector`, and patch status.
   */
  onJob(job: V1Job): void | Promise<void>;
  /**
   * A Pod we manage changed. Implementations call failure-detector on
   * the pod (and may correlate with the parent Job).
   */
  onPod(pod: V1Pod): void | Promise<void>;
  /** Optional: surface watcher errors to the caller's logger. */
  onError?(err: unknown): void;
}

/**
 * Build a Job + Pod informer pair. Caller starts both via the returned
 * handles and is responsible for `stop()` on shutdown. Errors emitted
 * by either underlying watch trigger `handler.onError` plus a 5-second
 * automatic restart, matching the AgentTask informer pattern.
 *
 * Returns one combined "informer-set" object so main.ts can manage the
 * pair as a unit.
 */
export interface JobPodInformerSet {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface JobPodInformerOptions {
  /** Namespace to watch. Undefined = cluster-wide watch. */
  readonly namespace?: string;
  /**
   * Optional override of the restart backoff schedule (H6 — defaults
   * to 5s → 5min cap with 12 consecutive-failure cap). Tests inject
   * a deterministic schedule + fake timer; production leaves
   * `restartOpts` undefined.
   */
  readonly restartOpts?: RestartOptions;
  /** Test-only timer injection so the backoff doesn't sleep on real time. */
  readonly restartTimer?: RestartTimer;
}

export function createJobPodInformer(
  kc: KubeConfig,
  coreApi: CoreV1Api,
  batchListFn: () => Promise<V1JobList>,
  handler: JobPodHandler,
  opts: JobPodInformerOptions = {},
): JobPodInformerSet {
  const jobListWrapper = async (): Promise<KubernetesListObject<V1Job>> => {
    const res = await batchListFn();
    return res;
  };

  const podListWrapper = async (): Promise<KubernetesListObject<V1Pod>> => {
    const res =
      opts.namespace !== undefined
        ? await coreApi.listNamespacedPod({
            namespace: opts.namespace,
            labelSelector: MANAGED_BY_LABEL,
          })
        : await coreApi.listPodForAllNamespaces({
            labelSelector: MANAGED_BY_LABEL,
          });
    return res;
  };

  const labelQuery = `labelSelector=${encodeURIComponent(MANAGED_BY_LABEL)}`;
  const jobWatchPath =
    opts.namespace !== undefined
      ? `/apis/batch/v1/namespaces/${encodeURIComponent(opts.namespace)}/jobs?${labelQuery}`
      : `/apis/batch/v1/jobs?${labelQuery}`;
  const podWatchPath =
    opts.namespace !== undefined
      ? `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/pods?${labelQuery}`
      : `/api/v1/pods?${labelQuery}`;

  const jobInformer: Informer<V1Job> = makeInformer<V1Job>(kc, jobWatchPath, jobListWrapper);

  const podInformer: Informer<V1Pod> = makeInformer<V1Pod>(kc, podWatchPath, podListWrapper);

  // Wire add + update through the same handler — failure verdicts are
  // idempotent (markFailed skips terminal AgentTasks), so re-firing on
  // every relist is safe. Delete is a no-op since the AgentTask owner
  // GC takes care of cleanup.
  jobInformer.on('add', (j) => {
    void Promise.resolve(handler.onJob(j)).catch((err: unknown) => handler.onError?.(err));
  });
  jobInformer.on('update', (j) => {
    void Promise.resolve(handler.onJob(j)).catch((err: unknown) => handler.onError?.(err));
  });
  // H6 — use safeRestart with exponential backoff + cap on consecutive
  // failures instead of `setTimeout(() => void <informer>.start(), 5000)`.
  // Job + Pod each get their own restarter — they fail independently
  // (Pod watch may flake while Job watch is healthy and vice versa),
  // so consecutive-failure counts must NOT be shared. The cap-reached
  // callback is groundwork for M21 readiness-probe wiring (W3-Operator).
  const jobRestartLogger: InformerRestartLogger = {
    onStartRejected(err, attempt, nextDelayMs): void {
      handler.onError?.(err);
      console.error(
        `[kagent-operator] Job informer start() rejected (attempt ${attempt.toString()}, next delay ${nextDelayMs.toString()}ms):`,
        err,
      );
    },
    onCapReached(err, totalAttempts): void {
      handler.onError?.(err);
      console.error(
        `[kagent-operator] Job informer restart cap reached after ${totalAttempts.toString()} consecutive failures; Job watch is permanently broken:`,
        err,
      );
    },
  };
  const jobRestarter = createRestarter(
    jobInformer,
    jobRestartLogger,
    opts.restartOpts ?? {},
    opts.restartTimer ?? { setTimeout: (cb, ms) => void globalThis.setTimeout(cb, ms) },
  );
  jobInformer.on('error', (err) => {
    handler.onError?.(err);
    jobRestarter.safeRestart(err);
  });

  podInformer.on('add', (p) => {
    void Promise.resolve(handler.onPod(p)).catch((err: unknown) => handler.onError?.(err));
  });
  podInformer.on('update', (p) => {
    void Promise.resolve(handler.onPod(p)).catch((err: unknown) => handler.onError?.(err));
  });
  const podRestartLogger: InformerRestartLogger = {
    onStartRejected(err, attempt, nextDelayMs): void {
      handler.onError?.(err);
      console.error(
        `[kagent-operator] Pod informer start() rejected (attempt ${attempt.toString()}, next delay ${nextDelayMs.toString()}ms):`,
        err,
      );
    },
    onCapReached(err, totalAttempts): void {
      handler.onError?.(err);
      console.error(
        `[kagent-operator] Pod informer restart cap reached after ${totalAttempts.toString()} consecutive failures; Pod watch is permanently broken:`,
        err,
      );
    },
  };
  const podRestarter = createRestarter(
    podInformer,
    podRestartLogger,
    opts.restartOpts ?? {},
    opts.restartTimer ?? { setTimeout: (cb, ms) => void globalThis.setTimeout(cb, ms) },
  );
  podInformer.on('error', (err) => {
    handler.onError?.(err);
    podRestarter.safeRestart(err);
  });

  return {
    async start(): Promise<void> {
      await jobInformer.start();
      await podInformer.start();
    },
    async stop(): Promise<void> {
      await jobInformer.stop();
      await podInformer.stop();
    },
  };
}

/**
 * Pull the parent AgentTask name+namespace out of a Job/Pod's labels.
 * Returns null when the resource isn't tagged — defensive against
 * label-selector misses (e.g. a Job created out-of-band that happens
 * to satisfy our managed-by selector but lacks the task label).
 */
export function parentTaskRef(resource: {
  metadata?: { labels?: Record<string, string>; namespace?: string } | undefined;
}): { namespace: string; name: string } | null {
  const labels = resource.metadata?.labels ?? {};
  const name = labels[TASK_LABEL];
  const namespace = resource.metadata?.namespace;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof namespace !== 'string' || namespace.length === 0) return null;
  return { namespace, name };
}

/** Re-export so callers don't have to import the constant separately. */
export const TASK_LABEL_KEY = TASK_LABEL;
