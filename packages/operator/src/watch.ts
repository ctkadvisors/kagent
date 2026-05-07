/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentTask watch loop — wraps `@kubernetes/client-node`'s `makeInformer`
 * around the AgentTask collection. The operator can watch one namespace
 * (chart default) or the cluster-wide endpoint (advanced deployments
 * that provision agent-pod prerequisites in every workload namespace).
 */

import {
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type ObjectCache,
  makeInformer,
} from '@kubernetes/client-node';

import { API_GROUP, API_VERSION, type AgentTask, isAgentTask } from './crds/index.js';
import {
  type RestartOptions,
  type RestartTimer,
  type InformerRestartLogger,
  createRestarter,
} from './informer-restart.js';

/**
 * The intersection type returned by `@kubernetes/client-node`'s
 * `makeInformer`. Re-exported here so the operator's main wiring can
 * capture both the watch-lifecycle (`start`/`stop`) interface AND the
 * cached `list()`/`get()` interface in a single typed handle —
 * required for WS-I parent re-aggregate, which reads children from
 * the cache instead of issuing a fresh API list per child event.
 */
export type AgentTaskInformerWithCache = Informer<AgentTask> & ObjectCache<AgentTask>;

const PLURAL = 'agenttasks' as const;
const CLUSTER_WATCH_PATH = `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}` as const;

export interface AgentTaskInformerOptions {
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

/**
 * Reconcile-handler contract. The watch loop calls one of these per
 * event. Throwing from a handler is logged + swallowed so a single
 * malformed object doesn't crash the operator.
 */
export interface AgentTaskHandler {
  onAdd(task: AgentTask): void | Promise<void>;
  onUpdate(task: AgentTask): void | Promise<void>;
  onDelete(task: AgentTask): void | Promise<void>;
  onError?(err: unknown): void;
}

/**
 * Construct (but do not start) an Informer for AgentTasks. Caller
 * invokes `informer.start()` and is responsible for lifecycle (`stop()`
 * on shutdown). Errors emitted by the underlying watch trigger the
 * handler's optional `onError` plus an automatic 5-second restart.
 */
export function createAgentTaskInformer(
  kc: KubeConfig,
  api: CustomObjectsApi,
  handler: AgentTaskHandler,
  opts: AgentTaskInformerOptions = {},
): AgentTaskInformerWithCache {
  // CustomObjectsApi.listClusterCustomObject returns Promise<any> by design —
  // CRDs aren't in the OpenAPI schema the client was generated against.
  // Casting at the call site is the documented v1.x pattern for typed CRs.
  const listFn = async (): Promise<KubernetesListObject<AgentTask>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      opts.namespace !== undefined
        ? await api.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: opts.namespace,
            plural: PLURAL,
          })
        : await api.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: PLURAL,
          });
    return res as KubernetesListObject<AgentTask>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const watchPath =
    opts.namespace !== undefined
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(opts.namespace)}/${PLURAL}`
      : CLUSTER_WATCH_PATH;
  const informer = makeInformer<AgentTask>(kc, watchPath, listFn);

  informer.on('add', (obj) => {
    if (!isAgentTask(obj)) return;
    void Promise.resolve(handler.onAdd(obj)).catch((err: unknown) => {
      handler.onError?.(err);
    });
  });
  informer.on('update', (obj) => {
    if (!isAgentTask(obj)) return;
    void Promise.resolve(handler.onUpdate(obj)).catch((err: unknown) => {
      handler.onError?.(err);
    });
  });
  informer.on('delete', (obj) => {
    if (!isAgentTask(obj)) return;
    void Promise.resolve(handler.onDelete(obj)).catch((err: unknown) => {
      handler.onError?.(err);
    });
  });
  // H6 — use safeRestart with exponential backoff + cap on consecutive
  // failures instead of `setTimeout(() => void informer.start(), 5000)`.
  // The bare `void` discarded `start()` rejections (apiserver 401/404,
  // network refused) and re-tried every 5 seconds forever, allowing a
  // permanently-broken watch to look healthy from outside the operator
  // while quietly missing every event. The cap-reached callback is
  // groundwork for M21 readiness-probe wiring (W3-Operator).
  const restartLogger: InformerRestartLogger = {
    onStartRejected(err, attempt, nextDelayMs): void {
      // Surface the rejection to the caller's existing onError sink
      // (main.ts:1134-1136 → console.error). The structured shape lets
      // M21 hook a metric/audit emitter in here without touching the
      // restart path.
      handler.onError?.(err);
      console.error(
        `[kagent-operator] AgentTask informer start() rejected (attempt ${attempt.toString()}, next delay ${nextDelayMs.toString()}ms):`,
        err,
      );
    },
    onCapReached(err, totalAttempts): void {
      // Permanent break. M21 will use this to flip the readiness
      // probe; until then, log loudly so the operator's CrashLoop /
      // restart cycle eventually surfaces the issue to operators.
      handler.onError?.(err);
      console.error(
        `[kagent-operator] AgentTask informer restart cap reached after ${totalAttempts.toString()} consecutive failures; watch is permanently broken:`,
        err,
      );
    },
  };
  const restarter = createRestarter(
    informer,
    restartLogger,
    opts.restartOpts ?? {},
    opts.restartTimer ?? { setTimeout: (cb, ms) => void globalThis.setTimeout(cb, ms) },
  );
  informer.on('error', (err) => {
    handler.onError?.(err);
    restarter.safeRestart(err);
  });

  return informer;
}
