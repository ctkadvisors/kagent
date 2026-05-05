/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Substrate verifier reconciler — v0.1.7-rig.2.
 *
 * Lights up the deferred-from-v0.3.0 `verify_completion` substrate hook
 * (per docs/WAVES.md §6.3 deliverable 7). The CRD already carries
 * `AgentTask.spec.verifyContract` and `status.verification`; this module
 * is the runner side.
 *
 * ## What it does
 *
 * On every AgentTask `onUpdate` event (the operator's existing AgentTask
 * informer feeds the handler):
 *
 *   1. Trigger gate:
 *      - `status.phase === 'Completed'`
 *      - `spec.verifyContract` is set (`scriptRef` and/or `llmJudgePromptRef`)
 *      - `status.verification` is undefined (idempotency)
 *
 *   2. Dispatch:
 *      - `scriptRef` path → operator spawns a one-shot K8s Job whose
 *        container image runs the verifier script. The parent task's
 *        `result` + `payload` are mounted as a per-Job ConfigMap at
 *        `/var/kagent/verify/input.json`. Exit 0 → passed=true; non-zero
 *        → passed=false (with the script's terminated-state `message`
 *        captured as `reason`, truncated to 4 KiB).
 *      - `llmJudgePromptRef` path → operator fetches the prompt from
 *        Langfuse, renders it (substituting `{{outputs}}` with
 *        `JSON.stringify(parent.status.result)`), and POSTs to
 *        `KAGENT_LLM_GATEWAY_BASE_URL/chat/completions`. The expected
 *        response shape is `{ verdict: "pass" | "fail", reason: string }`
 *        embedded in `choices[0].message.content` (the rc-pilot
 *        verifier prompt body emits exactly this).
 *
 *   3. Status patch:
 *      `status.verification = { passed, mode, reason?, completedAt }`.
 *      The CRD type only exposes those four fields; we additionally
 *      thread `judgeRef` + `durationMs` into the audit emission so
 *      audit warehouses get the lifecycle snapshot without re-reading
 *      the spec.
 *
 *   4. Audit:
 *      - `verifier.started` at dispatch
 *      - `verifier.completed` on `passed: true`
 *      - `verifier.failed` on `passed: false`
 *
 * ## Both-paths-set policy
 *
 * Per the v0.1.7-rig.2 brief: when both `scriptRef` AND
 * `llmJudgePromptRef` are set, the verifier rejects fail-closed
 * (`passed: false`, `reason: 'verifier_misconfig:both_paths_set'`).
 * Admission could enforce this earlier; until that lands, the verifier
 * is the backstop. The CRD JSDoc still says "both is admissible" — that
 * doc is forward-looking; the runtime contract is exclusive-or.
 *
 * ## Idempotency
 *
 * Once `status.verification` is set the gate short-circuits — re-firing
 * on every relist is cheap. Concurrent dispatches are bounded by an
 * in-process keyed mutex on `task.metadata.uid` so two informer events
 * arriving within the same tick can't double-dispatch (the second one
 * waits for the first's status patch then sees the idempotency hit).
 *
 * ## Failure handling
 *
 * Every path that doesn't produce a clean verdict lands as
 * `passed: false` with a structured `reason` tag (`verifier_timeout`,
 * `verifier_returned_non_json`, `langfuse_fetch_failed`,
 * `gateway_error:<status>`, `script_exit_<n>`, etc.). The verifier
 * NEVER throws past the dispatcher loop — a buggy contract
 * configuration must not break the operator's informer.
 */

import type {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  V1ConfigMap,
  V1Job,
} from '@kubernetes/client-node';

import { API_GROUP, API_VERSION, type AgentTask, type VerifyContract } from './crds/index.js';
import { mergePatchOptions } from './k8s.js';

/* =====================================================================
 * Constants
 * ===================================================================== */

/**
 * Default gateway timeout in milliseconds. The brief calls out
 * `> 30s → passed:false with verifier_timeout`. Wired via
 * `KAGENT_VERIFIER_GATEWAY_TIMEOUT_MS` for tests / chart overrides.
 */
export const DEFAULT_VERIFIER_GATEWAY_TIMEOUT_MS = 30_000;

/**
 * Default per-task script Job `activeDeadlineSeconds`. Honored by the
 * AgentTask's `verifyContract.scriptRef.timeoutSeconds` when set;
 * otherwise this default applies.
 */
export const DEFAULT_VERIFIER_SCRIPT_TIMEOUT_SECONDS = 60;

/** Maximum bytes of script-output we capture as `reason` on failure. */
export const VERIFIER_REASON_MAX_BYTES = 4096;

/** Polling cadence (ms) while a verifier Job runs. */
export const VERIFIER_JOB_POLL_INTERVAL_MS = 500;

/** Default OpenAI-compatible chat-completions path. */
export const VERIFIER_GATEWAY_CHAT_PATH = '/chat/completions';

/** Container image used when a scriptRef has no operator-side override. */
export const DEFAULT_VERIFIER_SCRIPT_IMAGE =
  'ghcr.io/ctkadvisors/kagent-verifier-runner:0.1.7-rig.2';

/**
 * Label applied to verifier Jobs so the operator (and future GC sweeps)
 * can filter them out of the regular agent-Job stream.
 */
export const VERIFIER_JOB_LABEL = 'kagent.knuteson.io/verifier' as const;

/**
 * Stable suffix appended to the parent task's name to form the
 * verifier Job + ConfigMap names. Bounded to 16 chars (per K8s name
 * length rules + room for the existing `kat-<uid>` prefix).
 */
export const VERIFIER_JOB_NAME_SUFFIX = '-verify';

/* =====================================================================
 * Types
 * ===================================================================== */

/**
 * Audit hook fields. Kept in this module (rather than re-exporting the
 * concrete CloudEvents types) so test files don't need to drag in the
 * full envelope shape.
 */
export interface VerifierAuditFields {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string | undefined;
  readonly mode: 'script' | 'llmJudge';
  readonly judgeRef: string;
}

export type VerifierStartedFields = VerifierAuditFields;

export interface VerifierTerminalFields extends VerifierAuditFields {
  readonly durationMs: number;
}

export interface VerifierFailedFields extends VerifierTerminalFields {
  readonly reason: string;
}

/**
 * Audit hook surface — best-effort. Each callback returns a Promise
 * that the dispatcher catches; a buggy hook can't break verification.
 */
export interface VerifierAuditHooks {
  readonly emitVerifierStarted: (fields: VerifierStartedFields) => Promise<void>;
  readonly emitVerifierCompleted: (fields: VerifierTerminalFields) => Promise<void>;
  readonly emitVerifierFailed: (fields: VerifierFailedFields) => Promise<void>;
}

/**
 * Resolves a Langfuse-managed prompt body to a literal string. Mirror
 * of the agent-pod's `fetchPrompt` callback in
 * `packages/agent-pod/src/runner.ts:140` (kept structurally identical
 * so the operator and the agent-pod can share the same Langfuse v2
 * fetcher in a future refactor).
 *
 * Errors thrown from the resolver MUST surface as
 * `langfuse_fetch_failed` to the verifier's reason tag — the
 * dispatcher catches and tags accordingly.
 */
export type FetchPromptFn = (name: string, version?: number) => Promise<string>;

/**
 * OpenAI-compatible chat-completions response shape — we only consume
 * `choices[0].message.content` for verdict parsing.
 */
interface ChatCompletionsResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown };
  }>;
}

/**
 * The substrate's contract with the LLM-judge prompt: the model's
 * reply, after stripping any surrounding markdown fence, parses to
 * an object with a `verdict` field of `"pass" | "fail"` and a
 * human-readable `reason`.
 */
export interface VerifierJudgeReply {
  readonly verdict: 'pass' | 'fail';
  readonly reason: string;
}

/**
 * Inputs to a single verification dispatch.
 */
export interface VerifierDispatchDeps {
  readonly customApi: CustomObjectsApi;
  readonly batchApi: BatchV1Api;
  readonly coreApi: CoreV1Api;
  /** Optional — wire from `buildLangfusePromptFetcher(process.env)`. Required for `llmJudgePromptRef` mode. */
  readonly fetchPrompt?: FetchPromptFn;
  /** Optional — required for `llmJudgePromptRef` mode. */
  readonly gatewayBaseUrl?: string;
  readonly gatewayApiKey?: string;
  /** Default model when the prompt template doesn't carry one. Falls back to the parent Agent's model when also unset. */
  readonly defaultModel?: string;
  /** Container image override for `scriptRef` mode. */
  readonly scriptImage?: string;
  /** Operator-namespaced ServiceAccount the verifier Job runs under. */
  readonly serviceAccountName?: string;
  /** Audit emission. Best-effort — undefined = no-op. */
  readonly audit?: VerifierAuditHooks;
  /** Test-only — substitute `Date.now()`. */
  readonly now?: () => number;
  /** Test-only — substitute `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Override gateway timeout. */
  readonly gatewayTimeoutMs?: number;
  /** Override Job poll interval (tests bring this down to 5ms). */
  readonly jobPollIntervalMs?: number;
}

/**
 * The verdict the dispatcher writes to `status.verification`. The
 * CRD types only carry `passed | mode | reason | completedAt`; the
 * dispatcher forwards `judgeRef` + `durationMs` to the audit hook
 * separately.
 */
export interface VerifierVerdict {
  readonly passed: boolean;
  readonly mode: 'script' | 'llmJudge';
  readonly reason?: string;
  readonly completedAt: string;
}

/**
 * Public dispatch result — exposed so callers can log + tests can
 * assert without parsing the patched status back from a fake apiserver.
 */
export interface VerifierDispatchResult {
  readonly action: 'verified' | 'skipped';
  readonly reason?: string;
  readonly verdict?: VerifierVerdict;
  readonly judgeRef?: string;
  readonly durationMs?: number;
}

/* =====================================================================
 * Trigger gate — pure function. Tests drive this in isolation.
 * ===================================================================== */

/**
 * Decide whether the AgentTask should trigger verification on this
 * informer event. Pure — the dispatcher composes I/O around this.
 */
export function shouldRunVerifier(task: AgentTask): boolean {
  if (task.status?.phase !== 'Completed') return false;
  if (task.spec.verifyContract === undefined) return false;
  if (task.status?.verification !== undefined) return false;
  // Defensive: spec must carry at least one mode. Empty contract =
  // no-op (matches the schema-only forward-compat behavior shipped in
  // v0.3.0-capabilities — see the verifyContract JSDoc on the CRD).
  const c = task.spec.verifyContract;
  if (c.scriptRef === undefined && c.llmJudgePromptRef === undefined) return false;
  return true;
}

/**
 * Choose the dispatch path. `script` wins when both are set ONLY for
 * the in-pod path-selection convenience; the dispatcher itself
 * fail-closes on `both_paths_set` per the v0.1.7-rig.2 brief.
 */
export function pickDispatchMode(
  contract: VerifyContract,
):
  | { readonly mode: 'script' }
  | { readonly mode: 'llmJudge' }
  | { readonly mode: 'misconfig'; readonly reason: string } {
  const hasScript = contract.scriptRef !== undefined;
  const hasJudge = contract.llmJudgePromptRef !== undefined;
  if (hasScript && hasJudge)
    return { mode: 'misconfig', reason: 'verifier_misconfig:both_paths_set' };
  if (!hasScript && !hasJudge)
    return { mode: 'misconfig', reason: 'verifier_misconfig:no_paths_set' };
  if (hasScript) return { mode: 'script' };
  return { mode: 'llmJudge' };
}

/**
 * Truncate an arbitrary stdout/stderr blob to fit inside the
 * `status.verification.reason` field. Bytes-aware so we don't split
 * a multi-byte UTF-8 codepoint mid-rune.
 */
export function truncateReason(s: string, maxBytes = VERIFIER_REASON_MAX_BYTES): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Trim and re-decode; fallback path strips a single byte at a time
  // to step back into a clean UTF-8 boundary.
  let cut = maxBytes;
  while (cut > 0) {
    const candidate = buf.subarray(0, cut).toString('utf8');
    if (Buffer.byteLength(candidate, 'utf8') === cut) return `${candidate}…(truncated)`;
    cut--;
  }
  return '…(truncated)';
}

/**
 * Render the LLM-judge prompt body. The contract is `{{outputs}}`
 * is the substituted token; we accept `{{ outputs }}` (with optional
 * whitespace) too. The dispatcher feeds the parent task's
 * `status.result` JSON-serialized.
 */
export function renderLlmJudgePrompt(template: string, parentResultJson: string): string {
  return template.replace(/\{\{\s*outputs\s*\}\}/g, parentResultJson);
}

/**
 * Parse the verdict envelope out of the model's reply. Strips a single
 * pair of surrounding code fences (` ```json ... ``` ` is common) so
 * a model that helpfully wraps JSON-in-fences still produces a usable
 * verdict. Returns `null` on any structural mismatch — the dispatcher
 * tags this as `verifier_returned_non_json`.
 */
export function parseVerifierJudgeReply(content: string): VerifierJudgeReply | null {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { verdict?: unknown; reason?: unknown };
  if (obj.verdict !== 'pass' && obj.verdict !== 'fail') return null;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { verdict: obj.verdict, reason };
}

/* =====================================================================
 * Reconciler — composes the gate + dispatch + status patch.
 * ===================================================================== */

/**
 * Per-process keyed mutex keyed on `task.metadata.uid`. Bounds
 * concurrent dispatches for the same AgentTask to one — second event
 * within the same tick `await`s the first's promise + sees the
 * idempotency hit on its own re-evaluation.
 */
class TaskKeyedMutex {
  private readonly inFlight = new Map<string, Promise<VerifierDispatchResult>>();

  async run(
    key: string,
    op: () => Promise<VerifierDispatchResult>,
  ): Promise<VerifierDispatchResult> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return await existing;
    }
    const promise = op().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return await promise;
  }
}

export interface VerifierReconciler {
  /**
   * Hook the operator's AgentTask `onUpdate` calls into here. The
   * reconciler decides on its own whether the event is a verifier
   * trigger (returns `{ action: 'skipped' }` otherwise).
   *
   * NEVER throws — a buggy verifier contract must not surface as a
   * watch error.
   */
  onAgentTaskUpdate(task: AgentTask): Promise<VerifierDispatchResult>;
}

/**
 * Build the verifier reconciler. Production wiring lives in
 * `main.ts`'s `buildHandler` — when `KAGENT_VERIFIER_ENABLED=true`,
 * `onUpdate` calls into `verifier.onAgentTaskUpdate(task)` after the
 * existing dispatch + parent-aggregate paths.
 */
export function buildVerifierReconciler(deps: VerifierDispatchDeps): VerifierReconciler {
  const mutex = new TaskKeyedMutex();
  const reconciler: VerifierReconciler = {
    async onAgentTaskUpdate(task: AgentTask): Promise<VerifierDispatchResult> {
      try {
        if (!shouldRunVerifier(task)) {
          return { action: 'skipped', reason: 'gate-false' };
        }
        const uid = task.metadata.uid;
        if (typeof uid !== 'string' || uid.length === 0) {
          return { action: 'skipped', reason: 'missing-uid' };
        }
        return await mutex.run(uid, async () => {
          // Re-check the gate inside the mutex — the prior holder may
          // have already patched `status.verification`. The informer
          // cache snapshot we received may be stale in that window.
          const fresh = await reReadTask(task, deps).catch(() => task);
          if (!shouldRunVerifier(fresh)) {
            return { action: 'skipped', reason: 'idempotent-hit' };
          }
          return await dispatchVerification(fresh, deps);
        });
      } catch (err) {
        // Defensive: should never bubble — but if `dispatchVerification`
        // throws we log and treat as skipped.
        console.error(
          `[kagent-operator/verifier] dispatch raised for ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}:`,
          err,
        );
        return { action: 'skipped', reason: 'dispatch-error' };
      }
    },
  };
  return reconciler;
}

/* =====================================================================
 * Re-read task — defensive against stale informer caches.
 * ===================================================================== */

async function reReadTask(task: AgentTask, deps: VerifierDispatchDeps): Promise<AgentTask> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return task;
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const res = await deps.customApi.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: 'agenttasks',
    name,
  });
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  return res as AgentTask;
}

/* =====================================================================
 * Dispatch — orchestration only. Calls one of the two path-handlers
 * based on the contract's mode and patches `status.verification` with
 * the verdict.
 * ===================================================================== */

async function dispatchVerification(
  task: AgentTask,
  deps: VerifierDispatchDeps,
): Promise<VerifierDispatchResult> {
  const contract = task.spec.verifyContract;
  if (contract === undefined) {
    return { action: 'skipped', reason: 'no-contract' };
  }
  const startedAt = (deps.now ?? Date.now)();
  const pick = pickDispatchMode(contract);

  if (pick.mode === 'misconfig') {
    const verdict: VerifierVerdict = {
      passed: false,
      // pickJudgeRefForMisconfig — present a stable mode label even
      // when neither (or both) refs are populated. We bias to
      // `llmJudge` because that's the path RC-Pilot exercises; tests
      // pin both paths.
      mode: contract.scriptRef !== undefined ? 'script' : 'llmJudge',
      reason: pick.reason,
      completedAt: new Date(startedAt).toISOString(),
    };
    const judgeRef = describeJudgeRef(contract, verdict.mode);
    await emitStarted(task, deps, verdict.mode, judgeRef);
    await patchVerificationStatus(task, deps, verdict);
    const durationMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
    await emitFailed(task, deps, verdict.mode, judgeRef, durationMs, pick.reason);
    return { action: 'verified', verdict, judgeRef, durationMs };
  }

  // Real dispatch.
  const judgeRef = describeJudgeRef(contract, pick.mode);
  await emitStarted(task, deps, pick.mode, judgeRef);

  let verdict: VerifierVerdict;
  if (pick.mode === 'script') {
    verdict = await runScriptVerifier(task, contract, deps, startedAt);
  } else {
    verdict = await runLlmJudgeVerifier(task, contract, deps, startedAt);
  }

  await patchVerificationStatus(task, deps, verdict);
  const durationMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
  if (verdict.passed) {
    await emitCompleted(task, deps, verdict.mode, judgeRef, durationMs);
  } else {
    await emitFailed(task, deps, verdict.mode, judgeRef, durationMs, verdict.reason ?? 'unknown');
  }
  return { action: 'verified', verdict, judgeRef, durationMs };
}

function describeJudgeRef(contract: VerifyContract, mode: 'script' | 'llmJudge'): string {
  if (mode === 'script') {
    return contract.scriptRef?.name ?? '(unset-scriptRef)';
  }
  const ref = contract.llmJudgePromptRef;
  if (ref === undefined) return '(unset-llmJudgePromptRef)';
  return ref.version !== undefined ? `${ref.name}@${String(ref.version)}` : ref.name;
}

/* =====================================================================
 * Script path
 * ===================================================================== */

async function runScriptVerifier(
  task: AgentTask,
  contract: VerifyContract,
  deps: VerifierDispatchDeps,
  startedAt: number,
): Promise<VerifierVerdict> {
  const scriptRef = contract.scriptRef;
  if (scriptRef === undefined) {
    return failVerdict('script', 'verifier_misconfig:no_paths_set', startedAt);
  }
  const namespace = task.metadata.namespace ?? 'default';
  const taskName = task.metadata.name ?? 'unknown';
  const verifierName = makeVerifierName(taskName);
  const cmName = `${verifierName}-input`;
  const jobName = verifierName;

  // 1. Build + create the input ConfigMap. OwnerRef → the AgentTask
  //    so cascading delete reaps it when the task is deleted.
  const inputJson = buildVerifierInputJson(task);
  const cm = buildVerifierConfigMap(task, cmName, inputJson);
  try {
    await deps.coreApi.createNamespacedConfigMap({ namespace, body: cm });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      console.error('[kagent-operator/verifier] input ConfigMap create failed:', err);
      return failVerdict('script', `script_dispatch_error:configmap_create`, startedAt);
    }
  }

  // 2. Build + create the Job. Same OwnerRef pattern.
  const image = deps.scriptImage ?? DEFAULT_VERIFIER_SCRIPT_IMAGE;
  const timeoutSeconds = DEFAULT_VERIFIER_SCRIPT_TIMEOUT_SECONDS;
  const job = buildVerifierJob(task, jobName, cmName, image, timeoutSeconds, scriptRef.name, deps);
  try {
    await deps.batchApi.createNamespacedJob({ namespace, body: job });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      console.error('[kagent-operator/verifier] verifier Job create failed:', err);
      return failVerdict('script', `script_dispatch_error:job_create`, startedAt);
    }
  }

  // 3. Poll the Job until terminal. `activeDeadlineSeconds` is the
  //    backstop; we also bound poll-time to `(timeoutSeconds + 5)`
  //    seconds in wall-clock so a stuck-Pending Job lands as a
  //    `verifier_timeout` rather than dragging the reconciler.
  const pollInterval = deps.jobPollIntervalMs ?? VERIFIER_JOB_POLL_INTERVAL_MS;
  const wallClockDeadlineMs = startedAt + (timeoutSeconds + 5) * 1000;
  while ((deps.now ?? Date.now)() < wallClockDeadlineMs) {
    let observed: V1Job;
    try {
      observed = await deps.batchApi.readNamespacedJob({ namespace, name: jobName });
    } catch (err) {
      console.warn('[kagent-operator/verifier] Job read failed:', err);
      // Poll-loop transient — keep trying until deadline.
      await sleep(pollInterval);
      continue;
    }
    const succeeded = observed.status?.succeeded ?? 0;
    const failed = observed.status?.failed ?? 0;
    if (succeeded > 0) {
      return passVerdict('script', startedAt);
    }
    if (failed > 0) {
      const tail = readScriptFailureMessage(observed);
      const conditionReason = observed.status?.conditions?.find((c) => c.type === 'Failed')?.reason;
      const exit = guessExitCode(observed);
      const tag =
        conditionReason === 'DeadlineExceeded'
          ? 'verifier_timeout'
          : exit !== undefined
            ? `script_exit_${String(exit)}`
            : 'script_failed';
      const reason = tail.length > 0 ? `${tag}: ${truncateReason(tail)}` : tag;
      return failVerdict('script', reason, startedAt);
    }
    await sleep(pollInterval);
  }
  return failVerdict('script', 'verifier_timeout', startedAt);
}

function makeVerifierName(parentName: string): string {
  // K8s name budget = 253; the suffix is short. Truncate the parent
  // half so `<parent>-verify` stays under the limit even for long
  // parent names.
  const prefix = parentName.length > 200 ? parentName.slice(0, 200) : parentName;
  return `${prefix}${VERIFIER_JOB_NAME_SUFFIX}`;
}

function buildVerifierInputJson(task: AgentTask): string {
  return JSON.stringify({
    taskUid: task.metadata.uid ?? '',
    taskNamespace: task.metadata.namespace ?? 'default',
    taskName: task.metadata.name ?? '',
    payload: task.spec.payload ?? null,
    inputs: task.spec.inputs ?? [],
    result: task.status?.result ?? null,
    outputs: task.status?.outputs ?? [],
  });
}

function buildVerifierConfigMap(task: AgentTask, cmName: string, inputJson: string): V1ConfigMap {
  const namespace = task.metadata.namespace ?? 'default';
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: cmName,
      namespace,
      labels: {
        'kagent.knuteson.io/task': task.metadata.name ?? '',
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        [VERIFIER_JOB_LABEL]: 'true',
      },
      ownerReferences: [
        {
          apiVersion: task.apiVersion,
          kind: task.kind,
          name: task.metadata.name ?? '',
          uid: task.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    data: {
      'input.json': inputJson,
    },
  };
}

function buildVerifierJob(
  task: AgentTask,
  jobName: string,
  cmName: string,
  image: string,
  timeoutSeconds: number,
  scriptName: string,
  deps: VerifierDispatchDeps,
): V1Job {
  const namespace = task.metadata.namespace ?? 'default';
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'kagent.knuteson.io/task': task.metadata.name ?? '',
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        [VERIFIER_JOB_LABEL]: 'true',
      },
      ownerReferences: [
        {
          apiVersion: task.apiVersion,
          kind: task.kind,
          name: task.metadata.name ?? '',
          uid: task.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      activeDeadlineSeconds: timeoutSeconds,
      template: {
        metadata: {
          labels: {
            'kagent.knuteson.io/task': task.metadata.name ?? '',
            'kagent.knuteson.io/managed-by': 'kagent-operator',
            [VERIFIER_JOB_LABEL]: 'true',
          },
        },
        spec: {
          restartPolicy: 'Never',
          ...(deps.serviceAccountName !== undefined && {
            serviceAccountName: deps.serviceAccountName,
          }),
          containers: [
            {
              name: 'verifier',
              image,
              env: [
                { name: 'KAGENT_VERIFIER_INPUT_PATH', value: '/var/kagent/verify/input.json' },
                { name: 'KAGENT_VERIFIER_SCRIPT_NAME', value: scriptName },
              ],
              volumeMounts: [
                {
                  name: 'input',
                  mountPath: '/var/kagent/verify',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'input',
              configMap: { name: cmName },
            },
          ],
        },
      },
    },
  };
}

/**
 * Best-effort failure message extraction. We don't have a Pod handle
 * here — `readNamespacedJob` returns the Job, not its Pod's stdout.
 * The `terminated.message` field on a Pod's containerStatus is the
 * canonical k8s carrier for "what did the container print before it
 * died"; without a Pod read, we fall back to the Job condition's
 * `message`. Caller passes namespace + parent uid for log context.
 */
function readScriptFailureMessage(job: V1Job): string {
  const conds = job.status?.conditions ?? [];
  for (const c of conds) {
    if ((c.type === 'Failed' || c.type === 'FailureTarget') && typeof c.message === 'string') {
      return c.message;
    }
  }
  return '';
}

function guessExitCode(job: V1Job): number | undefined {
  // K8s' V1Job doesn't carry the container exit code directly; the
  // message-string usually does though. Defensive parse.
  const msg = job.status?.conditions?.find((c) => c.type === 'Failed')?.message ?? '';
  const m = msg.match(/exit code (\d+)/i);
  if (m === null) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/* =====================================================================
 * LLM-judge path
 * ===================================================================== */

async function runLlmJudgeVerifier(
  task: AgentTask,
  contract: VerifyContract,
  deps: VerifierDispatchDeps,
  startedAt: number,
): Promise<VerifierVerdict> {
  const ref = contract.llmJudgePromptRef;
  if (ref === undefined) {
    return failVerdict('llmJudge', 'verifier_misconfig:no_paths_set', startedAt);
  }
  if (deps.gatewayBaseUrl === undefined || deps.gatewayBaseUrl.length === 0) {
    return failVerdict('llmJudge', 'verifier_misconfig:gateway_unconfigured', startedAt);
  }
  if (deps.fetchPrompt === undefined) {
    return failVerdict('llmJudge', 'verifier_misconfig:langfuse_unconfigured', startedAt);
  }

  // 1. Fetch the prompt body.
  let template: string;
  try {
    template = await deps.fetchPrompt(ref.name, ref.version);
  } catch (err) {
    console.warn(
      `[kagent-operator/verifier] Langfuse fetch for "${ref.name}" failed:`,
      err instanceof Error ? err.message : err,
    );
    return failVerdict('llmJudge', 'langfuse_fetch_failed', startedAt);
  }

  // 2. Render with parent outputs substituted.
  const resultJson = JSON.stringify(task.status?.result ?? null);
  const renderedPrompt = renderLlmJudgePrompt(template, resultJson);

  // 3. POST to the gateway. AbortSignal.timeout caps the round-trip.
  const baseUrl = deps.gatewayBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}${VERIFIER_GATEWAY_CHAT_PATH}`;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeout = deps.gatewayTimeoutMs ?? DEFAULT_VERIFIER_GATEWAY_TIMEOUT_MS;
  const model = deps.defaultModel ?? '';
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: renderedPrompt }],
    temperature: 0,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (typeof deps.gatewayApiKey === 'string' && deps.gatewayApiKey.length > 0) {
    headers.authorization = `Bearer ${deps.gatewayApiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('aborted'));
    if (isAbort) {
      return failVerdict('llmJudge', 'verifier_timeout', startedAt);
    }
    console.warn('[kagent-operator/verifier] gateway fetch raised:', err);
    return failVerdict('llmJudge', 'gateway_error:network', startedAt);
  }
  if (!response.ok) {
    return failVerdict('llmJudge', `gateway_error:${String(response.status)}`, startedAt);
  }

  let parsedBody: ChatCompletionsResponse;
  try {
    parsedBody = (await response.json()) as ChatCompletionsResponse;
  } catch (err) {
    console.warn('[kagent-operator/verifier] gateway returned non-JSON:', err);
    return failVerdict('llmJudge', 'verifier_returned_non_json', startedAt);
  }

  const content = parsedBody.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return failVerdict('llmJudge', 'verifier_returned_non_json', startedAt);
  }

  const reply = parseVerifierJudgeReply(content);
  if (reply === null) {
    return failVerdict('llmJudge', 'verifier_returned_non_json', startedAt);
  }

  if (reply.verdict === 'pass') {
    return passVerdict('llmJudge', startedAt);
  }
  // verdict === 'fail'
  const failReason =
    reply.reason.length > 0 ? `verdict:fail: ${truncateReason(reply.reason)}` : 'verdict:fail';
  return failVerdict('llmJudge', failReason, startedAt);
}

/* =====================================================================
 * Verdict helpers + status patch
 * ===================================================================== */

function passVerdict(mode: 'script' | 'llmJudge', startedAt: number): VerifierVerdict {
  return {
    passed: true,
    mode,
    completedAt: new Date(Math.max(startedAt, Date.now())).toISOString(),
  };
}

function failVerdict(
  mode: 'script' | 'llmJudge',
  reason: string,
  startedAt: number,
): VerifierVerdict {
  return {
    passed: false,
    mode,
    reason,
    completedAt: new Date(Math.max(startedAt, Date.now())).toISOString(),
  };
}

async function patchVerificationStatus(
  task: AgentTask,
  deps: VerifierDispatchDeps,
  verdict: VerifierVerdict,
): Promise<void> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return;
  // Merge-patch into the existing status — only the verification slice
  // is overwritten. We do NOT flip phase to Failed even when
  // passed=false; the schema's contract says verifyContract failure
  // is OBSERVABLE (audit + status field) but doesn't mutate the
  // existing terminal phase. A future v0.3.x bump may strengthen this
  // to flip to `phase=Failed reason=verify_failed` per the original
  // CRD JSDoc — that's a separate decision, see WAVES.md §6.3.
  const body = {
    status: {
      verification: {
        passed: verdict.passed,
        mode: verdict.mode,
        ...(verdict.reason !== undefined && { reason: verdict.reason }),
        completedAt: verdict.completedAt,
      },
    },
  };
  try {
    await deps.customApi.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: 'agenttasks',
        name,
        body,
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.error(`[kagent-operator/verifier] status patch failed for ${namespace}/${name}:`, err);
  }
}

/* =====================================================================
 * Audit emission helpers — best-effort.
 * ===================================================================== */

async function emitStarted(
  task: AgentTask,
  deps: VerifierDispatchDeps,
  mode: 'script' | 'llmJudge',
  judgeRef: string,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await deps.audit.emitVerifierStarted({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: task.spec.targetAgent,
      mode,
      judgeRef,
    });
  } catch (err) {
    console.warn('[kagent-operator/verifier] audit started raised:', err);
  }
}

async function emitCompleted(
  task: AgentTask,
  deps: VerifierDispatchDeps,
  mode: 'script' | 'llmJudge',
  judgeRef: string,
  durationMs: number,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await deps.audit.emitVerifierCompleted({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: task.spec.targetAgent,
      mode,
      judgeRef,
      durationMs,
    });
  } catch (err) {
    console.warn('[kagent-operator/verifier] audit completed raised:', err);
  }
}

async function emitFailed(
  task: AgentTask,
  deps: VerifierDispatchDeps,
  mode: 'script' | 'llmJudge',
  judgeRef: string,
  durationMs: number,
  reason: string,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await deps.audit.emitVerifierFailed({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: task.spec.targetAgent,
      mode,
      judgeRef,
      durationMs,
      reason,
    });
  } catch (err) {
    console.warn('[kagent-operator/verifier] audit failed raised:', err);
  }
}
