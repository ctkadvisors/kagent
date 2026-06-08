/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentTask status writeback — translates a `RunResult` into an
 * RFC 6902 JSON Patch on the task's status subresource. Phase 3 stops
 * at "task ran + status patched"; the operator's reconcile loop reads
 * the patched status on its next watch event and is done.
 *
 * In-cluster auth comes from the agent pod's mounted ServiceAccount
 * token (RBAC granted by the operator's Helm chart).
 *
 * Audit C2 H8 (2026-05-06) — non-clobbering writes via JSON Patch
 * `test`. Two writers race for the AgentTask `status.phase` transition
 * to terminal:
 *   - the agent-pod (this module, after the loop unwinds), and
 *   - the operator's job-watch reconciler (when the kubelet reports
 *     the Job's `Failed` condition before the pod gets a chance to
 *     patch — e.g., OOMKilled, SIGKILL after grace period).
 *
 * Pre-fix, both writers used `application/merge-patch+json` with no
 * resourceVersion precondition: last-writer-wins. A pod that completed
 * 200ms before SIGKILL would write `Completed` and then the operator's
 * job-watch (reading the Job's terminal condition) could patch `Failed`,
 * clobbering the truthful Completed phase.
 *
 * Fix: send the patch as RFC 6902 JSON Patch with a `test` op asserting
 * `status.phase` IS one of the non-terminal values (`Pending` /
 * `Dispatched`). The apiserver enforces the test atomically. Kubernetes
 * distributions differ in how they report a failed JSON Patch `test`:
 * SUBSTRATE-V1.md §3.2 names `412 Precondition Failed`, while live K3s
 * reports `422 Invalid`. We treat both as precondition candidates, then
 * confirm the current status before dropping. A patch is only dropped
 * when the AgentTask is already terminal; otherwise the error propagates.
 *
 * NOTE: the test op encodes the disjunction by trying each candidate
 * value in sequence — JSON Patch `test` matches a single value, so we
 * issue separate writeStatus attempts when needed. In practice the
 * pre-terminal phase is almost always `Dispatched` by the time the pod
 * boots; we attempt that first, then fall back to `Pending` if the
 * test op fails (which means the operator hasn't promoted the task
 * out of Pending yet — a benign race during dispatcher delay).
 */

import { CustomObjectsApi, KubeConfig, setHeaderOptions } from '@kubernetes/client-node';

import type { PodConfig } from './env.js';
import type { ArtifactRef, RunResult } from './runner.js';

/**
 * Per-call options forcing the Content-Type to JSON Patch (RFC 6902).
 * The generated `patchNamespacedCustomObjectStatus` defaults to
 * `application/json-patch+json` already; we set it explicitly so a
 * future client-node default change doesn't silently swap content
 * types out from under us.
 */
const jsonPatchOptions = setHeaderOptions('Content-Type', 'application/json-patch+json');

const API_GROUP = 'kagent.knuteson.io';
const API_VERSION = 'v1alpha1';
const PLURAL = 'agenttasks';

/**
 * Phases that are "not yet terminal" — the only states from which we
 * are willing to overwrite `status.phase`. Order matters: `Dispatched`
 * is overwhelmingly the most common pre-terminal state by the time the
 * pod is patching, so we try it first to minimize wasted apiserver
 * roundtrips. `Pending` is the fallback for the brief window between
 * AgentTask creation and dispatcher promotion.
 */
const NON_TERMINAL_PHASES_TO_TRY: readonly string[] = ['Dispatched', 'Pending'];

/**
 * One RFC 6902 op. Narrowly typed to the two ops `writeStatus` builds:
 * `test` for the non-terminal precondition, `add` for the field writes.
 * Apiserver's json-patch implementation treats `add` as upsert on
 * existing fields, matching merge-patch semantics for field overwrites
 * the runtime cares about.
 */
export type JsonPatchOp =
  | { readonly op: 'test'; readonly path: string; readonly value: unknown }
  | { readonly op: 'add'; readonly path: string; readonly value: unknown };

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
   * the patch minimal — no need to clear a field that was never set).
   * See `docs/ARTIFACTS.md`.
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
 * RunResult. Empty registry → returns `{}` so the caller's patch stays
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
 * Translate a `StatusPatch` into the RFC 6902 op array we send.
 *
 * Layout: a single `test` op asserting `status.phase` matches the
 * supplied `expectedPhase` (one of `NON_TERMINAL_PHASES_TO_TRY`),
 * followed by `add` ops for each field present on the patch. We use
 * `add` rather than `replace` because `replace` requires the path to
 * exist; `add` upserts. This means the same op array works on a task
 * whose `status` subresource has never been written.
 *
 * Exported for the unit-test suite.
 */
export function buildJsonPatchOps(patch: StatusPatch, expectedPhase: string): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [
    { op: 'test', path: '/status/phase', value: expectedPhase },
    { op: 'add', path: '/status/phase', value: patch.phase },
    { op: 'add', path: '/status/completedAt', value: patch.completedAt },
  ];
  if (patch.result !== undefined) {
    ops.push({ op: 'add', path: '/status/result', value: patch.result });
  }
  if (patch.error !== undefined) {
    ops.push({ op: 'add', path: '/status/error', value: patch.error });
  }
  if (patch.structuralVerdict !== undefined) {
    ops.push({
      op: 'add',
      path: '/status/structuralVerdict',
      value: patch.structuralVerdict,
    });
  }
  if (patch.artifacts !== undefined) {
    ops.push({ op: 'add', path: '/status/artifacts', value: patch.artifacts });
  }
  return ops;
}

/**
 * True iff the error is an apiserver response shape that can represent
 * "json-patch precondition (test op) failed". The SUBSTRATE-V1.md §3.2
 * contract names this as 412 Precondition Failed; live K3s returns 422
 * Invalid for the same failed JSON Patch `test`. `writeStatus` only
 * swallows these after a follow-up status read confirms a terminal
 * AgentTask phase, so genuine invalid 422s still propagate.
 *
 * Exported for tests so the differentiation against 409 Conflict and
 * ordinary server errors is asserted at the type-level there.
 */
export function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 412 || code === 422;
}

function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' || typeof code === 'string') return String(code);
  return 'unknown';
}

function statusPhase(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const status = (obj as { status?: unknown }).status;
  if (typeof status !== 'object' || status === null) return undefined;
  const phase = (status as { phase?: unknown }).phase;
  return typeof phase === 'string' ? phase : undefined;
}

function isTerminalPhase(phase: string | undefined): boolean {
  return phase === 'Completed' || phase === 'Failed';
}

async function readCurrentStatusPhase(
  config: PodConfig,
  api: CustomObjectsApi,
): Promise<string | undefined> {
  const obj: unknown = await api.getNamespacedCustomObjectStatus({
    group: API_GROUP,
    version: API_VERSION,
    namespace: config.taskNamespace,
    plural: PLURAL,
    name: config.taskName,
  });
  return statusPhase(obj);
}

/**
 * Write the status patch to the cluster using a JSON-Patch with a
 * `test` op precondition (audit C2 H8 fix). On 412/422 precondition
 * candidates, we try each expected non-terminal phase. If every guarded
 * patch fails, we read the live status. Only a confirmed terminal phase
 * is dropped; otherwise the last precondition-like error propagates.
 *
 * The test op tries `Dispatched` first (the dominant pre-terminal
 * phase by the time the pod is patching), then `Pending` (rare;
 * dispatcher hadn't promoted yet).
 */
export async function writeStatus(
  config: PodConfig,
  patch: StatusPatch,
  api: CustomObjectsApi,
): Promise<void> {
  let lastPreconditionErr: unknown;
  for (const expectedPhase of NON_TERMINAL_PHASES_TO_TRY) {
    const ops = buildJsonPatchOps(patch, expectedPhase);
    try {
      await api.patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: config.taskNamespace,
          plural: PLURAL,
          name: config.taskName,
          body: ops,
        },
        jsonPatchOptions,
      );
      return;
    } catch (err) {
      if (isPreconditionFailed(err)) {
        lastPreconditionErr = err;
        continue;
      }
      throw err;
    }
  }
  const currentPhase = await readCurrentStatusPhase(config, api);
  if (!isTerminalPhase(currentPhase)) {
    throw lastPreconditionErr;
  }

  // All NON_TERMINAL_PHASES_TO_TRY returned a precondition-like error,
  // and the follow-up status read confirms the AgentTask is already in
  // a terminal phase. Drop silently per H8 fix contract. Log a single
  // info line so the race is observable in pod logs but not alarming.
  const detail =
    lastPreconditionErr instanceof Error
      ? lastPreconditionErr.message
      : String(lastPreconditionErr);
  const code = errorCode(lastPreconditionErr);
  console.log(
    `[kagent-agent-pod] status patch dropped: another writer already terminalized ${config.taskNamespace}/${config.taskName} (code=${code}, phase=${currentPhase}: ${detail})`,
  );
}

/** Convenience for callers — load default kubeconfig + build the API client. */
export function makeCustomObjectsApi(): CustomObjectsApi {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CustomObjectsApi);
}
