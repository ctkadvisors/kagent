/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * K8s informer that keeps the in-process `ModelIndex` in sync with
 * `ModelEndpoint` CRs in the configured namespace. Mirrors the
 * agent-task informer pattern in `packages/operator/src/watch.ts`.
 *
 * On every event we also update the AIMD controller's bounds for
 * the (model, backendUrl) pair — that way a CR-level cap change
 * surfaces on the next request without a router-side re-read step.
 *
 * Wave 1B owns the canonical CRD definition + RBAC; this module
 * assumes the gateway's ServiceAccount has `modelendpoints:[get,
 * list, watch]` granted by Wave 1C's chart. Without that grant the
 * informer surfaces a 403 in `onError` and the gateway logs +
 * keeps the LAST known cache state until RBAC is fixed.
 */

import {
  CustomObjectsApi,
  KubeConfig,
  type KubernetesListObject,
  makeInformer,
  type Informer,
} from '@kubernetes/client-node';

import type { AimdController } from './aimd.js';
import type { ModelIndex } from './model-index.js';
import type { ModelEndpoint } from './types.js';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const PLURAL = 'modelendpoints';

export interface ModelEndpointWatchOptions {
  readonly namespace: string;
}

export interface ModelEndpointWatch {
  readonly informer: Informer<ModelEndpoint>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build (but do not start) the informer. Caller invokes `start()`
 * to begin the watch and `stop()` on shutdown.
 *
 * Returns the informer so tests / debug tooling can inspect cached
 * state via informer.list() — the same pattern the operator uses.
 */
export function createModelEndpointWatch(
  kc: KubeConfig,
  api: CustomObjectsApi,
  modelIndex: ModelIndex,
  aimd: AimdController,
  opts: ModelEndpointWatchOptions,
): ModelEndpointWatch {
  const listFn = async (): Promise<KubernetesListObject<ModelEndpoint>> => {
    // CustomObjectsApi.listNamespacedCustomObject is typed as Promise<any>
    // by `@kubernetes/client-node` (CRDs aren't in the OpenAPI schema the
    // client was generated against). The double-cast through `unknown` is
    // the documented v1.x pattern for typed CR lists — same dance used by
    // packages/operator/src/watch.ts.
    const res: unknown = await api.listNamespacedCustomObject({
      group: KAGENT_GROUP,
      version: KAGENT_VERSION,
      namespace: opts.namespace,
      plural: PLURAL,
    });
    return res as KubernetesListObject<ModelEndpoint>;
  };

  const watchPath = `/apis/${KAGENT_GROUP}/${KAGENT_VERSION}/namespaces/${encodeURIComponent(opts.namespace)}/${PLURAL}`;
  const informer = makeInformer<ModelEndpoint>(kc, watchPath, listFn);

  const apply = (ep: ModelEndpoint): void => {
    if (!isModelEndpoint(ep)) return;
    modelIndex.upsert(ep);
    aimd.updateBounds(ep.spec.model, ep.spec.backendUrl, {
      seed: ep.spec.inFlight.seed,
      max: ep.spec.inFlight.max,
      minSafe: ep.spec.minSafe ?? 1,
    });
  };

  informer.on('add', apply);
  informer.on('update', apply);
  informer.on('delete', (ep) => {
    if (!isModelEndpoint(ep)) return;
    modelIndex.delete(ep.spec.model);
  });
  informer.on('error', (err) => {
    console.error('[llm-gateway] model-endpoint watch error:', err);
    setTimeout(() => {
      void informer.start();
    }, 5_000);
  });

  return {
    informer,
    start(): Promise<void> {
      return informer.start();
    },
    stop(): Promise<void> {
      return informer.stop();
    },
  };
}

/** Type guard — defends against malformed CR list payloads. */
export function isModelEndpoint(obj: unknown): obj is ModelEndpoint {
  if (obj === null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.kind !== 'ModelEndpoint') return false;
  const spec = o.spec as Record<string, unknown> | undefined;
  if (spec === undefined) return false;
  if (typeof spec.model !== 'string') return false;
  if (typeof spec.backendKind !== 'string') return false;
  if (typeof spec.backendUrl !== 'string') return false;
  const inFlight = spec.inFlight as Record<string, unknown> | undefined;
  if (inFlight === undefined) return false;
  if (typeof inFlight.seed !== 'number' || typeof inFlight.max !== 'number') return false;
  return true;
}
