/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentTask watch loop — wraps `@kubernetes/client-node`'s `makeInformer`
 * around the cluster-wide AgentTask collection. Phase 2 only ships the
 * pipeline; the reconcile body lands in C4.
 *
 * Cluster-wide watch in v0.1; namespace scoping is a v0.2 affordance
 * once multi-tenant becomes a real workload concern.
 */

import {
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  makeInformer,
} from '@kubernetes/client-node';

import { API_GROUP, API_VERSION, type AgentTask, isAgentTask } from './crds/index.js';

const PLURAL = 'agenttasks' as const;
const WATCH_PATH = `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}` as const;

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
 * Construct (but do not start) an Informer for AgentTasks across all
 * namespaces. Caller invokes `informer.start()` and is responsible for
 * lifecycle (`stop()` on shutdown). Errors emitted by the underlying
 * watch trigger the handler's optional `onError` plus an automatic
 * 5-second restart — matches the resilience pattern documented in
 * @kubernetes/client-node README.
 */
export function createAgentTaskInformer(
  kc: KubeConfig,
  api: CustomObjectsApi,
  handler: AgentTaskHandler,
): Informer<AgentTask> {
  // CustomObjectsApi.listClusterCustomObject returns Promise<any> by design —
  // CRDs aren't in the OpenAPI schema the client was generated against.
  // Casting at the call site is the documented v1.x pattern for typed CRs.
  const listFn = async (): Promise<KubernetesListObject<AgentTask>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await api.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL,
    });
    return res as KubernetesListObject<AgentTask>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const informer = makeInformer<AgentTask>(kc, WATCH_PATH, listFn);

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
