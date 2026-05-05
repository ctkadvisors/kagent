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

import { CustomObjectsApi, KubeConfig, setHeaderOptions } from '@kubernetes/client-node';

import type { PodConfig } from './env.js';
import type { ArtifactRef, RunResult } from './runner.js';

/**
 * Per-call options forcing the Content-Type to merge-patch. The
 * generated `patchNamespacedCustomObjectStatus` defaults to
 * `application/json-patch+json` (RFC 6902, expects an array of ops);
 * we send merge bodies (`{ status: { phase, ... } }`) which need
 * RFC 7396 — apiserver rejects with
 * `cannot unmarshal object into Go value of type []handlers.jsonPatchOp`
 * otherwise.
 */
const mergePatchOptions = setHeaderOptions('Content-Type', 'application/merge-patch+json');

const API_GROUP = 'kagent.knuteson.io';
const API_VERSION = 'v1alpha1';
const PLURAL = 'agenttasks';

export interface StatusPatch {
  readonly phase: 'Completed' | 'Failed';
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt: string;
  readonly structuralVerdict?: { readonly suspicious: readonly string[] };
  /**
   * Artifact references produced by the agent run, forwarded as-is from
   * `RunResult.artifacts` (which itself merges the in-pod
   * ArtifactRegistry's snapshot with trace-harvested refs — see
   * `runner.ts` `mergeArtifactSources`). Empty array is omitted (keeps
   * the merge-patch minimal — no need to clear a field that was never
   * set). See `docs/ARTIFACTS.md`.
   */
  readonly artifacts?: readonly ArtifactRef[];
}

/**
 * Translate a RunResult into a status patch. Pure function — split out
 * from the K8s call so it's testable without booting a kube client.
 *
 * Artifact-flush contract (v0.1 P3 wire-up):
 *   - The registry is flushed on EVERY status patch (Completed AND
 *     Failed paths), not just at completion. This means a partial run
 *     that landed two artifacts before timing out still surfaces both
 *     refs in `AgentTask.status.artifacts` — the operator's downstream
 *     consumers (Workbench, sibling AgentTasks, GC) get a faithful
 *     view of what work survived.
 *   - The same applies to non-completed terminal paths (cancellation,
 *     budget_exceeded, timeout) routed through `Failed`. The runner
 *     populates `RunResult.artifacts` from the same registry snapshot
 *     in all cases — see `runAgentTask` in `runner.ts`.
 */
export function buildStatusPatch(result: RunResult, now: Date): StatusPatch {
  const completedAt = now.toISOString();
  const verdict = { suspicious: [...result.flags] };
  // Forward artifacts as-is when present + non-empty. Conditional spread
  // keeps the patch minimal for the common (no-artifacts) case so it
  // round-trips identically to pre-P3 behavior.
  const artifactsPatch =
    result.artifacts && result.artifacts.length > 0
      ? { artifacts: [...result.artifacts] }
      : undefined;
  if (result.status === 'completed') {
    return {
      phase: 'Completed',
      result: { content: result.finalContent },
      completedAt,
      structuralVerdict: verdict,
      ...(artifactsPatch !== undefined && artifactsPatch),
    };
  }
  // Treat any non-completed terminal status (failed / cancelled /
  // budget_exceeded / timeout) as Failed at the K8s status level —
  // the actual TerminalStatus + error message survive in the trace
  // for offline replay. Artifacts produced before the failure still
  // get surfaced (a partial run can have written real outputs).
  const message = result.error?.message ?? `loop ended with status=${result.status}`;
  return {
    phase: 'Failed',
    error: message,
    completedAt,
    structuralVerdict: verdict,
    ...(artifactsPatch !== undefined && artifactsPatch),
  };
}

/**
 * Helper: build a status patch directly from an in-pod
 * {@link ArtifactRegistry} snapshot rather than a full RunResult.
 * Used by callers that want to flush artifacts mid-run (heartbeat /
 * intermediate status update path) without inventing a synthetic
 * RunResult. Empty registry → returns just `{ artifacts: [] }`-empty
 * (i.e. undefined patch field) so the caller's merge-patch stays
 * minimal.
 *
 * NOTE: v0.1 only patches at terminal-completion (see `main.ts`); this
 * helper is here so the wiring is in place when a future heartbeat
 * path lands. Tests cover both shapes.
 */
export function buildArtifactsOnlyPatch(
  artifacts: readonly ArtifactRef[],
): Pick<StatusPatch, 'artifacts'> {
  if (artifacts.length === 0) return {};
  return { artifacts: [...artifacts] };
}

/**
 * Write the status patch to the cluster. Throws on K8s API failure.
 */
export async function writeStatus(
  config: PodConfig,
  patch: StatusPatch,
  api: CustomObjectsApi,
): Promise<void> {
  await api.patchNamespacedCustomObjectStatus(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: config.taskNamespace,
      plural: PLURAL,
      name: config.taskName,
      body: { status: patch },
    },
    mergePatchOptions,
  );
}

/** Convenience for callers — load default kubeconfig + build the API client. */
export function makeCustomObjectsApi(): CustomObjectsApi {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CustomObjectsApi);
}
