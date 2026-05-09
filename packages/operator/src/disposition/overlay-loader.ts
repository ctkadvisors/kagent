/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-01 — operator-side disposition overlay loader.
 *
 * Lists ConfigMaps in a namespace bearing the
 * `kagent.knuteson.io/agent-disposition=true` label, parses each
 * via `parseDispositionConfigMap` from `@kagent/dto`, and returns
 * the parsed overlays.
 *
 * Invalid ConfigMaps are FILTERED OUT (not silently treated as base
 * claims; not thrown). The caller's `logger.warn` is invoked once
 * per malformed overlay so operators can debug a failed schema.
 *
 * The cap-issuer narrowing step (plan 02) consumes the per-Agent
 * variant via `loadDispositionOverlayForAgent`. Phase 1 calls the
 * Kubernetes API on demand (no informer-cache); Phase 999.1 may
 * graduate the overlay to an informer-cached read.
 */

import type { CoreV1Api } from '@kubernetes/client-node';

import { parseDispositionConfigMap, DISPOSITION_LABEL, type DispositionOverlay } from '@kagent/dto';

export type { DispositionOverlay };
export { DISPOSITION_LABEL };

/** Minimal CoreV1Api surface the loader needs. Eases testing. */
export type DispositionCoreApi = Pick<CoreV1Api, 'listNamespacedConfigMap'>;

/** Optional logger. Production passes the operator's structured logger. */
export interface DispositionLoaderLogger {
  warn(msg: string): void;
}

/**
 * Lists every disposition overlay in `namespace`.
 *
 * Malformed ConfigMaps (parser returns `ok=false`) are filtered out
 * AND logged via the optional `logger`. Returns an empty array if
 * there are no overlays.
 */
export async function loadDispositionOverlays(
  coreApi: DispositionCoreApi,
  namespace: string,
  logger?: DispositionLoaderLogger,
): Promise<readonly DispositionOverlay[]> {
  const list = await coreApi.listNamespacedConfigMap({
    namespace,
    labelSelector: `${DISPOSITION_LABEL}=true`,
  });

  const overlays: DispositionOverlay[] = [];
  for (const cm of list.items ?? []) {
    const result = parseDispositionConfigMap(cm);
    if (!result.ok) {
      const cmName = cm.metadata?.name ?? '<unknown>';
      const cmNs = cm.metadata?.namespace ?? namespace;
      logger?.warn(
        `disposition overlay parse failed for ConfigMap ${cmNs}/${cmName}: ${result.error}`,
      );
      continue;
    }
    overlays.push(result.overlay);
  }
  return overlays;
}

/**
 * Returns the disposition overlay attached to the given Agent, or
 * `null` when no overlay (or only invalid overlays) reference that
 * Agent. The overlay's `agentRef` annotation is the join key.
 *
 * The cap-issuer narrowing step calls this BEFORE narrowing the
 * Agent's resolved claims; a `null` return means "no narrowing —
 * fall back to base Agent.spec.capabilityClaims".
 */
export async function loadDispositionOverlayForAgent(
  coreApi: DispositionCoreApi,
  agentNamespace: string,
  agentName: string,
  logger?: DispositionLoaderLogger,
): Promise<DispositionOverlay | null> {
  const overlays = await loadDispositionOverlays(coreApi, agentNamespace, logger);
  for (const overlay of overlays) {
    if (overlay.agentNamespace === agentNamespace && overlay.agentName === agentName) {
      return overlay;
    }
  }
  return null;
}
