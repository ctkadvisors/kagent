/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Admission reconciler — LLM gateway bundle, spec §3.2.
 *
 * The operator creates new Jobs in `spec.suspend: true` state when
 * KAGENT_ADMISSION_CONTROL_ENABLED=true. K8s holds off scheduling the
 * pod until something patches `spec.suspend: false`. This reconciler
 * is the "something": on every Job or ModelEndpoint event, it
 * re-evaluates the admission queue and un-suspends Jobs up to the
 * per-(model, namespace) and per-Agent caps.
 *
 * ## Cap layers
 *
 * Two layers, ANDed together:
 *
 *   1. Per-(model, namespace) cap, declared via the `ModelEndpoint`
 *      CRD. Cap = `status.observedInFlight ?? spec.inFlight.seed`. The
 *      gateway publishes `observedInFlight` as the AIMD self-tuner
 *      converges; the operator reads it so we always queue against
 *      the *actual* sustained capacity, not the static seed. If no
 *      ModelEndpoint matches a Job's model, the Job is FAIL-CLOSED
 *      (left suspended) — operators MUST declare a ModelEndpoint per
 *      model the cluster talks to.
 *
 *   2. Per-Agent cap, opt-in via `Agent.spec.maxInFlightTasks`. When
 *      set, no more than N un-suspended Jobs labeled with that Agent
 *      may run simultaneously. Useful when one Agent is hot enough to
 *      monopolize the per-model cap.
 *
 * ## Race handling (K8s optimistic concurrency)
 *
 * Two reconciler ticks could both decide to un-suspend Job X. The
 * second `kubectl patch` returns 409 Conflict (the apiserver's
 * resourceVersion check trips). On 409 we do NOT retry the same Job
 * — the racer already won — we re-list, refresh our view, and
 * re-evaluate which Job to admit next. This is the same pattern
 * `patchStatusWithRetry` (WS-E) uses for status writes.
 *
 * ## What this reconciler does NOT do
 *
 *   - Does NOT update `ModelEndpoint.status.observedInFlight`. That's
 *     the gateway's job (AIMD self-tuner). The operator only READS
 *     status.
 *   - Does NOT poll on a timer. Reconciliation is event-driven —
 *     subscribe to Job and ModelEndpoint events, re-evaluate the
 *     full admission queue on any of them. Pending queue is small
 *     (single-digit Jobs in steady state).
 *   - Does NOT touch suspend state when KAGENT_ADMISSION_CONTROL_ENABLED
 *     is false. The reconciler is registered (so flipping the env to
 *     true at upgrade time doesn't require operator-image rebuild) but
 *     `evaluate()` short-circuits to a no-op.
 *
 * Spec reference: docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md
 */

import type { V1Job } from '@kubernetes/client-node';

import type { Agent, ModelEndpoint } from './crds/index.js';
import { unsuspendJob as unsuspendJobApi } from './job-annotator.js';

/* =====================================================================
 * Constants
 * ===================================================================== */

/**
 * Pod label written by `buildJobSpec` so the admission reconciler can
 * select Jobs by their owning Agent for the per-Agent cap.
 */
export const AGENT_LABEL = 'kagent.knuteson.io/agent';

/* =====================================================================
 * Pure helpers — small, testable in isolation. The reconciler glue at
 * the bottom composes them.
 * ===================================================================== */

/**
 * v0.1.9 — read the operator-stamped `KAGENT_TASK_DEPTH` env off a Job.
 * Mirror of `extractModelFromJob`; reuses the single source of truth
 * from `job-spec.ts:buildJobSpec`. Returns `0` (root) when the env is
 * missing or malformed — same fail-closed posture as the agent-pod
 * `parseTaskDepth` and operator `parseTaskDepthLabel`.
 */
export function extractTaskDepthFromJob(job: V1Job): number {
  const containers = job.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return 0;
  const env = containers[0]?.env;
  if (!Array.isArray(env)) return 0;
  const depthEnv = env.find((e) => e.name === 'KAGENT_TASK_DEPTH');
  const value = depthEnv?.value;
  if (typeof value !== 'string' || value.length === 0) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * v0.1.9 — find suspended Jobs whose decoded depth exceeds `maxDepth`.
 * The operator's reconciler uses this to enumerate Jobs to mark Failed
 * (with `policy_denied:depth_exceeded`) so they don't sit suspended
 * forever waiting for capacity that should never come. Returns an
 * empty list when `maxDepth` is undefined (cap opt-in).
 */
export function findDepthViolatingJobs(
  jobs: readonly V1Job[],
  maxDepth: number | undefined,
): readonly V1Job[] {
  if (maxDepth === undefined) return [];
  const out: V1Job[] = [];
  for (const job of jobs) {
    if (extractTaskDepthFromJob(job) > maxDepth) out.push(job);
  }
  return out;
}

/**
 * Decode the model name from a Job's `KAGENT_AGENT_SPEC` env var.
 * Returns undefined when the env is missing, malformed JSON, or
 * doesn't carry a `model` field.
 *
 * The operator stamps `KAGENT_AGENT_SPEC` as JSON-encoded
 * `Agent.spec` on every spawned Job (see `job-spec.ts:buildJobSpec`).
 * We reuse that single source of truth rather than introducing a
 * second label/annotation that could drift.
 */
export function extractModelFromJob(job: V1Job): string | undefined {
  const containers = job.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return undefined;
  const env = containers[0]?.env;
  if (!Array.isArray(env)) return undefined;
  const specEnv = env.find((e) => e.name === 'KAGENT_AGENT_SPEC');
  const value = specEnv?.value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const model = (parsed as { model?: unknown }).model;
  if (typeof model !== 'string' || model.length === 0) return undefined;
  return model;
}

/**
 * Compute the live per-(model, endpoint) capacity. Reads
 * `status.observedInFlight` (gateway-published AIMD-tuned cap) when
 * present, falling back to `spec.inFlight.seed`. Never reads
 * `spec.inFlight.max` — that's the AIMD ceiling, not the current
 * capacity.
 */
export function computeCapacity(endpoint: ModelEndpoint): number {
  const observed = endpoint.status?.observedInFlight;
  if (typeof observed === 'number' && observed >= 0) return observed;
  return endpoint.spec.inFlight.seed;
}

/**
 * A Job has reached a terminal state when its status reports
 * succeeded>0 OR failed>0. Terminal Jobs do NOT hold capacity slots
 * even though they're still un-suspended — Kubernetes leaves Jobs
 * around for inspection / TTL cleanup but they're not running.
 *
 * Without this check the reconciler would count completed Jobs as
 * live forever, refusing to admit anything new until the Job's
 * owner deletes it (or TTL fires).
 */
function isTerminalJob(job: V1Job): boolean {
  const succeeded = job.status?.succeeded ?? 0;
  const failed = job.status?.failed ?? 0;
  return succeeded > 0 || failed > 0;
}

/**
 * Count currently live Jobs whose decoded model matches `model`.
 * "Live" means: NOT suspended AND NOT terminal (succeeded/failed).
 * Only live Jobs hold a capacity slot.
 */
export function countInFlightByModel(jobs: readonly V1Job[], model: string): number {
  let n = 0;
  for (const job of jobs) {
    if (job.spec?.suspend === true) continue;
    if (isTerminalJob(job)) continue;
    if (extractModelFromJob(job) === model) n++;
  }
  return n;
}

/**
 * Count currently live Jobs labeled with the Agent name. Used
 * for the per-Agent cap. Suspended + terminal Jobs don't count.
 */
export function countInFlightByAgent(jobs: readonly V1Job[], agentName: string): number {
  let n = 0;
  for (const job of jobs) {
    if (job.spec?.suspend === true) continue;
    if (isTerminalJob(job)) continue;
    if (job.metadata?.labels?.[AGENT_LABEL] === agentName) n++;
  }
  return n;
}

/* =====================================================================
 * Scheduler — pure decision function
 * ===================================================================== */

/**
 * Identifier for a Job that should be un-suspended.
 */
export interface JobRef {
  readonly namespace: string;
  readonly name: string;
}

/**
 * Inputs to the pure scheduler. All collections are flat lists; the
 * scheduler is responsible for indexing them by model/agent. Kept
 * small so unit tests can construct concrete inputs easily.
 */
export interface SelectAdmittableInput {
  /** Suspended Jobs awaiting admission. Order doesn't matter — we sort by creationTimestamp. */
  readonly suspendedJobs: readonly V1Job[];
  /** Currently un-suspended (running / scheduling) Jobs. Used for capacity counting. */
  readonly runningJobs: readonly V1Job[];
  /** ModelEndpoint per model name. */
  readonly modelEndpoints: ReadonlyMap<string, ModelEndpoint>;
  /** Per-Agent maxInFlightTasks override (Agent.spec.maxInFlightTasks). Absent agent = no cap. */
  readonly agentMaxInFlight: ReadonlyMap<string, number>;
  /**
   * v0.1.9 — cluster-level depth cap. When set, suspended Jobs whose
   * decoded `KAGENT_TASK_DEPTH` exceeds the cap are skipped (never
   * un-suspended). Mirror of the in-pod spawn-tool guardrail; the
   * operator's reconciler additionally walks `findDepthViolatingJobs`
   * to mark the underlying AgentTasks Failed. Undefined = no cap
   * (back-compat with installs that haven't set
   * KAGENT_AGENT_POD_MAX_DEPTH on the operator deployment).
   */
  readonly maxDepth?: number;
}

/**
 * Pick the set of suspended Jobs to admit on this tick. Pure —
 * no I/O, no patches. The reconciler's `evaluate()` invokes this and
 * then issues the corresponding patches.
 *
 * Order of admission: FIFO by `metadata.creationTimestamp` of the
 * Job (which the apiserver stamps at create time, monotonically).
 * No fairness scheduling across Agents in v1 — per the spec §6
 * decision deferral, weighted-fair-share waits for evidence.
 *
 * Algorithm:
 *   1. Sort suspended Jobs by creationTimestamp ascending.
 *   2. Initialize live-counter maps from `runningJobs`.
 *   3. For each Job in FIFO order:
 *      - Decode its model. If unset → skip (fail-closed).
 *      - Look up ModelEndpoint. If missing → skip (fail-closed).
 *      - Compute remaining capacity for this model = cap - liveByModel[model].
 *        If <= 0 → skip.
 *      - If Agent has a per-Agent cap and liveByAgent[agent] >= cap → skip.
 *      - Otherwise: queue for admission, increment both live counters
 *        (so subsequent decisions account for this admission).
 */
export function selectAdmittable(input: SelectAdmittableInput): readonly JobRef[] {
  const { suspendedJobs, runningJobs, modelEndpoints, agentMaxInFlight, maxDepth } = input;

  // Initialize live counters from currently-running Jobs.
  // Skip terminal Jobs — Kubernetes leaves succeeded/failed Jobs
  // around for inspection but they don't hold capacity.
  const liveByModel = new Map<string, number>();
  const liveByAgent = new Map<string, number>();
  for (const job of runningJobs) {
    if (job.spec?.suspend === true) continue;
    if (isTerminalJob(job)) continue;
    const model = extractModelFromJob(job);
    if (model !== undefined) {
      liveByModel.set(model, (liveByModel.get(model) ?? 0) + 1);
    }
    const agentName = job.metadata?.labels?.[AGENT_LABEL];
    if (typeof agentName === 'string' && agentName.length > 0) {
      liveByAgent.set(agentName, (liveByAgent.get(agentName) ?? 0) + 1);
    }
  }

  // Sort suspended Jobs FIFO. Defensive: missing creationTimestamp
  // sorts last (so a malformed Job can't starve a normal one).
  const sorted = [...suspendedJobs].sort((a, b) => {
    const ta = creationTime(a);
    const tb = creationTime(b);
    return ta - tb;
  });

  const admit: JobRef[] = [];
  for (const job of sorted) {
    const namespace = job.metadata?.namespace ?? 'default';
    const name = job.metadata?.name;
    if (typeof name !== 'string' || name.length === 0) continue;

    // v0.1.9 — cluster-level depth cap. When set, skip Jobs that exceed
    // it; the reconciler's `runEvaluatePass` separately walks
    // `findDepthViolatingJobs` and marks the underlying AgentTasks
    // Failed so the Job doesn't sit suspended forever. Cheaper than
    // the model lookup → run first.
    if (maxDepth !== undefined && extractTaskDepthFromJob(job) > maxDepth) continue;

    const model = extractModelFromJob(job);
    if (model === undefined) continue; // fail-closed

    const endpoint = modelEndpoints.get(model);
    if (endpoint === undefined) continue; // fail-closed: no ModelEndpoint declared

    const cap = computeCapacity(endpoint);
    const live = liveByModel.get(model) ?? 0;
    if (live >= cap) continue;

    // Per-Agent cap (opt-in).
    const agentName = job.metadata?.labels?.[AGENT_LABEL];
    if (typeof agentName === 'string' && agentName.length > 0) {
      const agentCap = agentMaxInFlight.get(agentName);
      if (typeof agentCap === 'number' && agentCap >= 0) {
        const liveAgent = liveByAgent.get(agentName) ?? 0;
        if (liveAgent >= agentCap) continue;
      }
    }

    admit.push({ namespace, name });
    liveByModel.set(model, live + 1);
    if (typeof agentName === 'string' && agentName.length > 0) {
      liveByAgent.set(agentName, (liveByAgent.get(agentName) ?? 0) + 1);
    }
  }
  return admit;
}

/**
 * Numeric creation time for sorting. Returns +Infinity for missing
 * timestamps so undated Jobs sort last (no starvation of well-formed
 * peers).
 */
function creationTime(job: V1Job): number {
  const ts = job.metadata?.creationTimestamp;
  if (ts === undefined || ts === null) return Number.POSITIVE_INFINITY;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  }
  return Number.POSITIVE_INFINITY;
}

/* =====================================================================
 * Reconciler — composes the pure scheduler with K8s I/O.
 * ===================================================================== */

/**
 * Lister callback returning Jobs from an informer cache. Receives an
 * optional namespace; when undefined returns all known Jobs (the
 * cache may itself be namespaced — caller's wiring decides).
 */
export type JobLister = (namespace?: string) => readonly V1Job[];

/**
 * Lister callback returning ModelEndpoints from an informer cache.
 */
export type ModelEndpointLister = (namespace?: string) => readonly ModelEndpoint[];

/**
 * Lookup an Agent CR by namespace + name, sourced from the operator's
 * Agent informer cache. Returns undefined when not present (no
 * per-Agent cap can be applied — falls through to the per-model cap
 * only).
 */
export type AgentLookupFn = (namespace: string, name: string) => Agent | undefined;

/**
 * Patch primitive — un-suspends a Job by name. Defaults to
 * `job-annotator.ts:unsuspendJob` in production wiring. Tests inject
 * a spy so they don't need a live BatchV1Api.
 */
export type UnsuspendJobFn = (namespace: string, name: string) => Promise<void>;

export interface AdmissionDeps {
  /**
   * Master switch. When false, `evaluate()` is a no-op. The
   * reconciler is still registered (so flipping the env to true
   * doesn't require an operator restart with new code) but does
   * nothing. Backwards-compatible default for installs that don't
   * deploy the LLM gateway sub-chart.
   *
   * Wired from `KAGENT_ADMISSION_CONTROL_ENABLED` env in `main.ts`.
   */
  readonly enabled: boolean;
  readonly listJobs: JobLister;
  readonly listModelEndpoints: ModelEndpointLister;
  readonly lookupAgent: AgentLookupFn;
  readonly unsuspendJob: UnsuspendJobFn;
  /**
   * v0.1.9 — cluster-level cap on AgentTask spawn-tree depth. Sourced
   * from `KAGENT_AGENT_POD_MAX_DEPTH` on the operator deployment.
   * When set, the admission scheduler skips suspended Jobs whose
   * decoded `KAGENT_TASK_DEPTH` exceeds the cap, AND
   * `runEvaluatePass` walks `findDepthViolatingJobs` to mark the
   * underlying AgentTasks Failed via `markTaskFailed`. Undefined =
   * no cap (back-compat).
   */
  readonly maxDepth?: number;
  /**
   * v0.1.9 — callback that marks an AgentTask Failed when its Job
   * exceeds the cluster depth cap. Wired in main.ts to
   * `markAgentTaskFailedFromExternal` so the resulting status patch
   * passes through the existing WS-E condition-merge pipeline. Tests
   * inject a spy. When undefined, depth-violating Jobs are still
   * skipped at admission but their AgentTasks aren't actively
   * Failed — they just stay suspended forever (which is also the
   * pre-v0.1.9 behavior for any unschedulable Job).
   */
  readonly markTaskFailed?: (
    ref: { readonly namespace: string; readonly name: string },
    reason: string,
  ) => Promise<void>;
}

export interface AdmissionSummary {
  /** Jobs successfully un-suspended this tick. */
  readonly admitted: number;
  /** Patches that returned 409 Conflict (lost the race). */
  readonly conflicts: number;
  /** Suspended Jobs we deliberately left alone (no ModelEndpoint, etc). */
  readonly skipped: number;
  /** Patches that failed for non-409 reasons (e.g. apiserver down). */
  readonly errors?: number;
}

export interface AdmissionReconciler {
  /**
   * Run one admission pass. Idempotent — re-firing on every event is
   * cheap when nothing has changed (no patches issued). Errors are
   * logged + counted, never thrown — a failed patch shouldn't crash
   * the informer.
   */
  evaluate(): Promise<AdmissionSummary>;
  /** Subscribe-handle: a Job event happened, re-evaluate. */
  onJobEvent(): Promise<void>;
  /** Subscribe-handle: a ModelEndpoint event happened, re-evaluate. */
  onModelEndpointEvent(): Promise<void>;
}

/**
 * Build the admission reconciler. Returns an object with `evaluate()`
 * (the worker) and event hooks (the triggers wired by `main.ts`'s
 * informer subscriptions).
 *
 * The returned object's `evaluate` field is deliberately writable so
 * tests can substitute a spy when verifying the event-trigger plumbing.
 * Production callers don't reassign it.
 */
export function buildAdmissionReconciler(deps: AdmissionDeps): AdmissionReconciler {
  const reconciler: AdmissionReconciler = {
    async evaluate(): Promise<AdmissionSummary> {
      if (!deps.enabled) {
        return { admitted: 0, conflicts: 0, skipped: 0 };
      }
      return await runEvaluatePass(deps);
    },
    async onJobEvent(): Promise<void> {
      if (!deps.enabled) return;
      // Delegate through `reconciler.evaluate` (not `runEvaluatePass`)
      // so test-time spy replacement works for both event handlers.
      await reconciler.evaluate();
    },
    async onModelEndpointEvent(): Promise<void> {
      if (!deps.enabled) return;
      await reconciler.evaluate();
    },
  };
  return reconciler;
}

/**
 * Single admission pass. Lists current state, runs the pure
 * scheduler, issues patches. On 409 (lost race), refresh the view
 * and re-evaluate — but only once per `evaluate()` call to bound
 * the work. The informer will fire another event the moment the
 * racer's patch lands, which retriggers us anyway.
 */
async function runEvaluatePass(deps: AdmissionDeps): Promise<AdmissionSummary> {
  let admitted = 0;
  let conflicts = 0;
  let skipped = 0;
  let errors = 0;

  // v0.1.9 — sweep depth-violators. List all suspended Jobs whose
  // decoded KAGENT_TASK_DEPTH exceeds the cluster cap and (when
  // `markTaskFailed` is wired) mark the underlying AgentTasks Failed
  // with `policy_denied:depth_exceeded`. The Job's name is the
  // task UID-derived `kat-<uid>`; we recover the AgentTask via the
  // operator-stamped `kagent.knuteson.io/task` label. Errors are
  // logged + counted but never thrown — the marking is best-effort
  // and the `selectAdmittable` skip below is a hard backstop.
  if (deps.maxDepth !== undefined && deps.markTaskFailed !== undefined) {
    const allJobs = deps.listJobs();
    const suspended = allJobs.filter((j) => j.spec?.suspend === true);
    const violators = findDepthViolatingJobs(suspended, deps.maxDepth);
    for (const job of violators) {
      const ns = job.metadata?.namespace ?? 'default';
      const taskName = job.metadata?.labels?.['kagent.knuteson.io/task'];
      if (typeof taskName !== 'string' || taskName.length === 0) continue;
      const depth = extractTaskDepthFromJob(job);
      const reason = `policy_denied:depth_exceeded — depth=${String(depth)} exceeds cluster cap=${String(deps.maxDepth)} (KAGENT_AGENT_POD_MAX_DEPTH)`;
      try {
        await deps.markTaskFailed({ namespace: ns, name: taskName }, reason);
      } catch (err) {
        console.error(
          `[kagent-operator] admission: failed to mark depth-violating AgentTask ${ns}/${taskName} Failed:`,
          err,
        );
        errors++;
      }
    }
  }

  // Snapshot 1 — initial decision pass.
  const decision1 = computeDecision(deps);
  skipped = decision1.skipped;

  // Issue patches sequentially. Sequential matters because we
  // counted capacity in the scheduler under the assumption that
  // every chosen Job lands; if one fails, the cap math no longer
  // matches reality. Sequential lets us course-correct on 409 by
  // re-evaluating from scratch.
  for (const ref of decision1.admittable) {
    try {
      await deps.unsuspendJob(ref.namespace, ref.name);
      admitted++;
    } catch (err) {
      if (isConflict(err)) {
        conflicts++;
        // Lost the race for this specific Job — break and re-evaluate
        // with refreshed view. Per spec: do NOT retry the same patch.
        break;
      }
      console.error(
        `[kagent-operator] admission: failed to un-suspend ${ref.namespace}/${ref.name}:`,
        err,
      );
      errors++;
    }
  }

  // Re-evaluation pass IF we hit a conflict — the informer cache
  // may have updated, the racer may have admitted a different Job,
  // a ModelEndpoint cap may have been re-tuned. Bound to one
  // re-evaluation per `evaluate()` call to avoid a busy loop.
  if (conflicts > 0) {
    const decision2 = computeDecision(deps);
    // Don't double-count `skipped` — the second pass counts the same
    // skipped queue. Use whichever is larger for the summary.
    skipped = Math.max(skipped, decision2.skipped);
    for (const ref of decision2.admittable) {
      try {
        await deps.unsuspendJob(ref.namespace, ref.name);
        admitted++;
      } catch (err) {
        if (isConflict(err)) {
          conflicts++;
          // Stop — give up this tick. The next informer event will
          // re-trigger.
          break;
        }
        console.error(
          `[kagent-operator] admission: failed to un-suspend ${ref.namespace}/${ref.name}:`,
          err,
        );
        errors++;
      }
    }
  }

  const summary: AdmissionSummary = {
    admitted,
    conflicts,
    skipped,
    ...(errors > 0 && { errors }),
  };
  return summary;
}

interface DecisionPass {
  readonly admittable: readonly JobRef[];
  /** Count of suspended Jobs we couldn't admit (no ModelEndpoint, capacity exhausted). */
  readonly skipped: number;
}

/**
 * Compute one decision pass — list current state, partition Jobs
 * into suspended / running, build the per-Agent cap map from Agent
 * lookups, run the scheduler. Returns the admittable list + a count
 * of suspended Jobs left in the queue for summary reporting.
 */
function computeDecision(deps: AdmissionDeps): DecisionPass {
  const allJobs = deps.listJobs();
  const suspendedJobs: V1Job[] = [];
  const runningJobs: V1Job[] = [];
  for (const job of allJobs) {
    if (job.spec?.suspend === true) suspendedJobs.push(job);
    else runningJobs.push(job);
  }

  // Build the model-endpoint map. Endpoints are indexed by
  // spec.model. If two endpoints declare the same model, the last
  // one wins — operator config error, but we don't crash; cluster
  // admins surface this via `kubectl get modelendpoints`.
  const modelEndpoints = new Map<string, ModelEndpoint>();
  for (const me of deps.listModelEndpoints()) {
    modelEndpoints.set(me.spec.model, me);
  }

  // Build per-Agent cap map by walking each suspended Job's Agent
  // label and looking up the Agent CR. Cached lookup (informer)
  // makes this cheap; missing Agent → no per-Agent cap entry.
  const agentMaxInFlight = new Map<string, number>();
  const seenAgents = new Set<string>();
  for (const job of [...suspendedJobs, ...runningJobs]) {
    const agentName = job.metadata?.labels?.[AGENT_LABEL];
    const namespace = job.metadata?.namespace ?? 'default';
    if (typeof agentName !== 'string' || agentName.length === 0) continue;
    const key = `${namespace}/${agentName}`;
    if (seenAgents.has(key)) continue;
    seenAgents.add(key);
    const agent = deps.lookupAgent(namespace, agentName);
    const cap = agent?.spec.maxInFlightTasks;
    if (typeof cap === 'number' && cap >= 0) {
      agentMaxInFlight.set(agentName, cap);
    }
  }

  const admittable = selectAdmittable({
    suspendedJobs,
    runningJobs,
    modelEndpoints,
    agentMaxInFlight,
    ...(deps.maxDepth !== undefined && { maxDepth: deps.maxDepth }),
  });

  // "Skipped" = suspended Jobs we did NOT admit. Useful for
  // observability (logs) and tests. Includes Jobs blocked on
  // missing ModelEndpoint, capacity exhausted, missing model, etc.
  const admittedNames = new Set(admittable.map((r) => `${r.namespace}/${r.name}`));
  let skipped = 0;
  for (const job of suspendedJobs) {
    const ns = job.metadata?.namespace ?? 'default';
    const nm = job.metadata?.name ?? '';
    if (!admittedNames.has(`${ns}/${nm}`)) skipped++;
  }
  return { admittable, skipped };
}

/**
 * Match either the v0.x `{ statusCode: 409 }` shape or the v1.x
 * `ApiException` with `code: 409`. Same predicate as
 * reconcile.ts:isConflict — kept duplicated here so admission stays
 * import-cycle-free against reconcile.
 */
function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

/* =====================================================================
 * Production wiring helper — exported so main.ts can build the
 * default `unsuspendJob` callback against the real BatchV1Api
 * without re-importing job-annotator separately.
 * ===================================================================== */

export { unsuspendJobApi };
