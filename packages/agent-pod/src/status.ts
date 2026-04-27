/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentTask status writeback — translates a `RunResult` into a JSON-
 * Patch on the task's status subresource. Phase 3 stops at "task ran
 * + status patched"; the operator's reconcile loop reads the patched
 * status on its next watch event and is done.
 *
 * In-cluster auth comes from the agent pod's mounted ServiceAccount
 * token (RBAC granted by the operator's Helm chart).
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import type { PodConfig } from './env.js';
import type { RunResult } from './runner.js';

const API_GROUP = 'kagent.knuteson.io';
const API_VERSION = 'v1alpha1';
const PLURAL = 'agenttasks';

export interface StatusPatch {
  readonly phase: 'Completed' | 'Failed';
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt: string;
  readonly structuralVerdict?: { readonly suspicious: readonly string[] };
}

/**
 * Translate a RunResult into a status patch. Pure function — split out
 * from the K8s call so it's testable without booting a kube client.
 */
export function buildStatusPatch(result: RunResult, now: Date): StatusPatch {
  const completedAt = now.toISOString();
  const verdict = { suspicious: [...result.flags] };
  if (result.status === 'completed') {
    return {
      phase: 'Completed',
      result: { content: result.finalContent },
      completedAt,
      structuralVerdict: verdict,
    };
  }
  // Treat any non-completed terminal status (failed / cancelled /
  // budget_exceeded / timeout) as Failed at the K8s status level —
  // the actual TerminalStatus + error message survive in the trace
  // for offline replay.
  const message = result.error?.message ?? `loop ended with status=${result.status}`;
  return {
    phase: 'Failed',
    error: message,
    completedAt,
    structuralVerdict: verdict,
  };
}

/**
 * Write the status patch to the cluster. Throws on K8s API failure.
 */
export async function writeStatus(
  config: PodConfig,
  patch: StatusPatch,
  api: CustomObjectsApi,
): Promise<void> {
  await api.patchNamespacedCustomObjectStatus({
    group: API_GROUP,
    version: API_VERSION,
    namespace: config.taskNamespace,
    plural: PLURAL,
    name: config.taskName,
    body: { status: patch },
  });
}

/** Convenience for callers — load default kubeconfig + build the API client. */
export function makeCustomObjectsApi(): CustomObjectsApi {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CustomObjectsApi);
}
