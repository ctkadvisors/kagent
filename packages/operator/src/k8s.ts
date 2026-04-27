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

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

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

/** Build a typed `CustomObjectsApi` from a KubeConfig. */
export function makeCustomObjectsApi(kc: KubeConfig): CustomObjectsApi {
  return kc.makeApiClient(CustomObjectsApi);
}
