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
  informer.on('error', (err) => {
    handler.onError?.(err);
    setTimeout(() => {
      void informer.start();
    }, 5000);
  });

  return informer;
}
