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

  // Audit-rev2 L12 — track which (namespace/name) bedrock CRs we've
  // already warned about so a steady-state cluster doesn't spam the
  // log on every informer resync.
  const warnedBedrockIdentities = new Set<string>();

  const apply = (ep: ModelEndpoint): void => {
    if (!isModelEndpoint(ep)) return;
    if (ep.spec.backendKind === 'bedrock') {
      // L12 — boot-time / observation-time diagnostic. The Bedrock
      // adapter is a stub in v1; loading a CR that points at it
      // means the first request will throw `BedrockNotImplementedError`
      // at runtime. Surface that as a structured warn-line at watch
      // time so an operator debugging a misconfiguration sees the
      // gap before any traffic arrives. Operator-side admission
      // (W5-Operator) is the load-bearing fix; this is a defence
      // in depth from the gateway's vantage point.
      const identity = `${ep.metadata.namespace ?? '<no-ns>'}/${ep.metadata.name}`;
      if (!warnedBedrockIdentities.has(identity)) {
        warnedBedrockIdentities.add(identity);
        console.warn(
          `[llm-gateway] ModelEndpoint observed with backendKind=bedrock ` +
            `(${identity}, model=${ep.spec.model}); the Bedrock adapter is ` +
            `not implemented in v1 of @kagent/llm-gateway. Requests routed ` +
            `to this CR will fail with BedrockNotImplementedError. See ` +
            `docs/MODEL-ROUTING.md §6.1 + packages/llm-gateway/src/providers/` +
            `bedrock-provider.ts for the re-enable recipe.`,
        );
      }
    }
    const result = modelIndex.upsert(ep);
    if (result.kind === 'collision') {
      // M20 — two CRs claiming the same `spec.model` is a
      // misconfiguration. Log a structured one-liner so the operator
      // can find the offending CR; do NOT update AIMD bounds (the
      // existing entry's CR keeps its routing). The collision could
      // be transient (a CR rename in flight) or persistent (two CRs
      // with the same model name); either way, deterministic routing
      // beats flapping.
      console.warn(
        `[llm-gateway] ModelEndpoint collision rejected: ` +
          `model=${ep.spec.model} ` +
          `existing=${result.existing.namespace}/${result.existing.name} ` +
          `(backendUrl=${result.existing.backendUrl}) ` +
          `incoming=${result.incoming.namespace}/${result.incoming.name} ` +
          `(backendUrl=${result.incoming.backendUrl})`,
      );
      return;
    }
    aimd.updateBounds(ep.spec.model, ep.spec.backendUrl, normalizeBounds(ep));
  };

  informer.on('add', apply);
  informer.on('update', apply);
  informer.on('delete', (ep) => {
    if (!isModelEndpoint(ep)) return;
    // M20 — pass the CR identity so we don't tombstone an entry that
    // belongs to a different (collision-survivor) CR.
    const identity = `${ep.metadata.namespace ?? '<no-ns>'}/${ep.metadata.name}`;
    modelIndex.delete(ep.spec.model, identity);
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

/**
 * Project a CR's `spec.inFlight.{seed,max}` + `spec.minSafe` into the
 * AIMD-controller bounds shape, applying the audit-B5 floor of 1 to
 * `minSafe`. Nullish-coalescing alone is NOT enough — `?? 1` only
 * substitutes for `null`/`undefined`, not `0`, so a CR with
 * `spec.minSafe: 0` would slip through and let the multiplicative-
 * decrease floor stay at 0 (which combined with `floor(cap/2)` would
 * leave the cap pinned at 0 indefinitely after the first 429/error).
 *
 * We clamp at watch time so the rest of the gateway code (router,
 * AIMD controller, admin/capacity surface) can assume `bounds.minSafe
 * >= 1` as an invariant.
 */
export function normalizeBounds(ep: ModelEndpoint): {
  seed: number;
  max: number;
  minSafe: number;
} {
  return {
    seed: ep.spec.inFlight.seed,
    max: ep.spec.inFlight.max,
    minSafe: Math.max(1, ep.spec.minSafe ?? 1),
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
