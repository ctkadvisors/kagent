/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Kubernetes client construction — narrow factory surface used by
 * the operator's main entrypoint and watch wiring. Kept separate from
 * `main.ts` so unit tests can inject mocked APIs without booting a
 * real KubeConfig.
 */

import {
  BatchV1Api,
  CustomObjectsApi,
  KubeConfig,
  setHeaderOptions,
} from '@kubernetes/client-node';

/**
 * Load KubeConfig from the standard places — in-cluster service-account
 * mount when running as a pod, otherwise `~/.kube/config` or `KUBECONFIG`
 * env. `loadFromDefault()` does both probes in order.
 */
export function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}

/**
 * Per-call options forcing the Content-Type to merge-patch on PATCH
 * requests against `CustomObjectsApi`.
 *
 * Why: the generated `patchNamespacedCustomObjectStatus` defaults to
 * `application/json-patch+json` (RFC 6902, expects an array body of
 * `{op, path, value}` triples). We always send RFC 7396 merge bodies
 * (`{ status: { phase, ... } }`). Without this override the apiserver
 * rejects with
 * `cannot unmarshal object into Go value of type []handlers.jsonPatchOp`.
 */
export const mergePatchOptions = setHeaderOptions('Content-Type', 'application/merge-patch+json');

/** Build a typed `CustomObjectsApi` from a KubeConfig. */
export function makeCustomObjectsApi(kc: KubeConfig): CustomObjectsApi {
  return kc.makeApiClient(CustomObjectsApi);
}

/** Build a typed `BatchV1Api` from a KubeConfig — used for Job creation. */
export function makeBatchApi(kc: KubeConfig): BatchV1Api {
  return kc.makeApiClient(BatchV1Api);
}
