/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Locality sub-team — speculative execution engine.
 *
 * When an AgentTask runs > `threshold * median(historical)` for its
 * Agent, the operator spawns a duplicate of the task with the SAME
 * idempotency key. The Wave 1 idempotency cache (`task-admission.ts`)
 * prevents double-effect: whichever task completes first records its
 * outputs; the second task hits the cache as a `replay` and returns
 * the cached outputs without re-running the LLM loop. The slower one
 * is marked `superseded` (a non-Failed terminal state distinct from
 * the normal `Completed` / `Failed` taxonomy).
 *
 * Per-Agent latency histogram is in-process — a 100-sample ring
 * buffer per Agent. Median is the simple p50 of the sample set; we
 * deliberately avoid HdrHistogram / t-digest to keep the engine
 * stateless across operator restarts (the ring resets on reboot —
 * speculative execution dampens itself for the first ~10 minutes
 * post-boot, which is also when operators are likely staring at
 * traces and don't want spurious duplicates).
 *
 * The decision module is pure; the spawn callable is injected so
 * tests don't need a CustomObjectsApi. The operator's main.ts wires
 * the callable to `customApi.createNamespacedCustomObject` shaped
 * against the AgentTask CRD. Defaults from
 * `docs/WAVES.md` §5.5: `threshold = 3.0`, `enabled = false` (off
 * by default — speculative doubles spawns and adds budget, only
 * worth it once latency is the bottleneck).
 */

import type { AffinityTask } from './types.js';

/* =====================================================================
 * Latency histogram — per-Agent ring buffer, 100 samples.
 * ===================================================================== */

/** Default per-Agent ring-buffer capacity. */
export const DEFAULT_HISTOGRAM_CAPACITY = 100;

/**
 * Minimum samples before we trust the median — a single sample's
 * p50 is itself; doubling task spawns based on n=1 evidence is the
 * exact pathology that kills latency-tuning attempts. Set to 5 so
 * the warm-up window is short but the signal is meaningful.
 */
export const DEFAULT_MIN_SAMPLES = 5;

/**
 * Default speculative-spawn threshold — task running > N × median
 * triggers the duplicate. Per WAVES.md §5.5 the default is 3.0.
 * Lower → more aggressive (more duplicates, more budget); higher →
 * more conservative (fewer duplicates, slower stragglers wait
 * longer).
 */
export const DEFAULT_SPECULATIVE_THRESHOLD = 3.0;

/**
 * Per-Agent in-memory latency-sample ring buffer. `record(durationMs)`
 * appends; the oldest sample is overwritten when the buffer fills.
 * `median()` returns the p50 of the current samples (not the
 * full-window median). `samples()` is a defensive copy for
 * diagnostics + tests.
 *
 * Memory: O(agents × capacity × 8 bytes). With capacity=100 and 1k
 * Agents, ~800 KiB — trivially small.
 */
export class LatencyHistogram {
  private readonly buf: number[];
  private size = 0;
  private writeIdx = 0;

  constructor(public readonly capacity: number = DEFAULT_HISTOGRAM_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `LatencyHistogram capacity must be a positive integer (got ${String(capacity)})`,
      );
    }
    this.buf = new Array<number>(capacity);
  }

  /** Append one observation in milliseconds; overwrites the oldest sample when full. */
  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.buf[this.writeIdx] = durationMs;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Number of recorded samples (capped at `capacity`). */
  count(): number {
    return this.size;
  }

  /** p50. Returns 0 when no samples have been recorded yet. */
  median(): number {
    if (this.size === 0) return 0;
    const arr: number[] = [];
    for (let i = 0; i < this.size; i++) {
      const v = this.buf[i];
      if (v !== undefined) arr.push(v);
    }
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    if (arr.length % 2 === 1) {
      return arr[mid] ?? 0;
    }
    const lo = arr[mid - 1] ?? 0;
    const hi = arr[mid] ?? 0;
    return (lo + hi) / 2;
  }

  /** Defensive copy of all current samples (for diagnostics + tests). */
  samples(): readonly number[] {
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) {
      const v = this.buf[i];
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}

/**
 * Per-Agent histogram registry. Threadsafe by Node single-threaded
 * convention (the operator runs one event-loop). Tests exercise a
 * fresh instance per case.
 */
export class LatencyHistogramRegistry {
  private readonly map = new Map<string, LatencyHistogram>();

  constructor(
    private readonly capacity: number = DEFAULT_HISTOGRAM_CAPACITY,
    private readonly minSamples: number = DEFAULT_MIN_SAMPLES,
  ) {}

  /** Append a sample for the given Agent. */
  record(agentName: string, durationMs: number): void {
    if (typeof agentName !== 'string' || agentName.length === 0) return;
    const h = this.histogramFor(agentName);
    h.record(durationMs);
  }

  /**
   * Return the agent's median latency in ms, OR `null` when fewer
   * than `minSamples` have been collected (= speculative decisions
   * are skipped during warmup).
   */
  median(agentName: string): number | null {
    const h = this.map.get(agentName);
    if (h === undefined) return null;
    if (h.count() < this.minSamples) return null;
    return h.median();
  }

  /** Test/diagnostic surface — sample count for a specific agent. */
  count(agentName: string): number {
    return this.map.get(agentName)?.count() ?? 0;
  }

  private histogramFor(agentName: string): LatencyHistogram {
    let h = this.map.get(agentName);
    if (h === undefined) {
      h = new LatencyHistogram(this.capacity);
      this.map.set(agentName, h);
    }
    return h;
  }
}

/* =====================================================================
 * Speculative engine — pure decision + injectable spawn callable.
 * ===================================================================== */

/**
 * Decision returned by `evaluateSpeculative`. `kind: 'spawn'` carries
 * the original AgentTask; the engine's caller invokes the spawn
 * callable to materialize the duplicate. `kind: 'skip'` carries a
 * `reason` for log/diagnostic visibility.
 */
export type SpeculativeDecision =
  | {
      readonly kind: 'spawn';
      readonly agentName: string;
      readonly elapsedMs: number;
      readonly medianMs: number;
      readonly thresholdMs: number;
    }
  | {
      readonly kind: 'skip';
      readonly reason:
        | 'disabled'
        | 'no-agent'
        | 'no-task-uid'
        | 'insufficient-samples'
        | 'under-threshold'
        | 'no-idempotency-key'
        | 'already-twin'
        | 'terminal'
        | 'no-start-time';
    };

/**
 * Twin-marker label the engine stamps on the spawned duplicate so a
 * subsequent evaluation pass can short-circuit (`already-twin`) and
 * the operator's status path can mark the loser `superseded` rather
 * than `Failed`. Sticky once stamped (the parent task NEVER carries
 * this label — only the duplicate does).
 */
export const SPECULATIVE_TWIN_LABEL = 'kagent.knuteson.io/speculative-twin' as const;

/**
 * Companion label tying a twin back to its primary's UID, so the
 * status-write path on the loser knows which AgentTask "owns" the
 * superseded transition. The race-loser inspects its peer's terminal
 * status; the winner records outputs in the idempotency cache.
 */
export const SPECULATIVE_PRIMARY_UID_LABEL = 'kagent.knuteson.io/speculative-primary-uid' as const;

/**
 * Inputs to a speculative-spawn evaluation. The engine is invoked
 * periodically by the operator (e.g. on AgentTask informer events
 * + a low-frequency timer for tasks that have been Pending for a
 * long time). Only takes the inputs it needs — the operator's full
 * AgentTask CR satisfies `AffinityTask` structurally.
 */
export interface EvaluateSpeculativeInput {
  readonly task: AffinityTask;
  /**
   * Elapsed wall-clock ms between task dispatch and "now". Computed
   * by the caller (typically `Date.now() - Date.parse(status.startedAt)`).
   * The engine treats negative or NaN values as `no-start-time`.
   */
  readonly elapsedMs: number;
  /**
   * Resolved Agent name (post capability resolution). Used as the
   * histogram lookup key.
   */
  readonly agentName: string;
  /**
   * Whether the task has reached a terminal phase (Completed |
   * Failed | superseded). Terminal tasks NEVER spawn a twin.
   */
  readonly isTerminal: boolean;
}

/**
 * Engine configuration — runtime defaults read from
 * `docs/WAVES.md` §5.5.
 */
export interface SpeculativeEngineOptions {
  /**
   * Master switch. Default `false` (matches the chart's
   * `locality.speculative.enabled: false`). When false, the engine
   * always returns `{ kind: 'skip', reason: 'disabled' }` — the
   * spawn callable is never invoked.
   */
  readonly enabled?: boolean;
  /**
   * Threshold multiplier vs. the per-Agent median. Default 3.0.
   * `elapsedMs > threshold * median` triggers the spawn.
   */
  readonly threshold?: number;
  /**
   * Minimum samples per Agent before the engine trusts the median.
   * Default 5 (= `DEFAULT_MIN_SAMPLES`).
   */
  readonly minSamples?: number;
  /**
   * Histogram ring-buffer capacity. Default 100 (= `DEFAULT_HISTOGRAM_CAPACITY`).
   */
  readonly capacity?: number;
}

/**
 * Decide — pure — whether to spawn a speculative duplicate of `task`.
 * Reads the Agent's median from the histogram registry; never touches
 * K8s. The caller is responsible for invoking the injected spawn
 * callable when the decision is `'spawn'`.
 */
export function evaluateSpeculative(
  input: EvaluateSpeculativeInput,
  registry: LatencyHistogramRegistry,
  options: SpeculativeEngineOptions = {},
): SpeculativeDecision {
  const enabled = options.enabled ?? false;
  if (!enabled) return { kind: 'skip', reason: 'disabled' };

  const threshold = options.threshold ?? DEFAULT_SPECULATIVE_THRESHOLD;
  const { task, elapsedMs, agentName, isTerminal } = input;

  if (typeof agentName !== 'string' || agentName.length === 0) {
    return { kind: 'skip', reason: 'no-agent' };
  }
  const taskUid = task.metadata.uid;
  if (typeof taskUid !== 'string' || taskUid.length === 0) {
    return { kind: 'skip', reason: 'no-task-uid' };
  }
  if (isTerminal) return { kind: 'skip', reason: 'terminal' };

  // Idempotency-key-less tasks can't be deduped → never spawn a
  // duplicate (the second task would re-issue all side effects).
  // The Wave 1 cache is the load-bearing safety; without an
  // idempotency key, the engine fails-closed.
  const idempotencyKey = readIdempotencyKey(task);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return { kind: 'skip', reason: 'no-idempotency-key' };
  }

  // A task that's ITSELF a speculative twin must not respawn — that
  // way an O(N!) chain is structurally impossible.
  if (task.metadata.labels?.[SPECULATIVE_TWIN_LABEL] !== undefined) {
    return { kind: 'skip', reason: 'already-twin' };
  }

  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { kind: 'skip', reason: 'no-start-time' };
  }

  const median = registry.median(agentName);
  if (median === null) {
    return { kind: 'skip', reason: 'insufficient-samples' };
  }

  // Median 0 is degenerate (every sample was 0ms — implausible but
  // possible if the operator just booted and recorded short-circuit
  // replays). Treat as "under-threshold" so the engine can't
  // accidentally divide-by-zero into "always spawn".
  if (median <= 0) return { kind: 'skip', reason: 'under-threshold' };

  const thresholdMs = threshold * median;
  if (elapsedMs <= thresholdMs) {
    return { kind: 'skip', reason: 'under-threshold' };
  }

  return {
    kind: 'spawn',
    agentName,
    elapsedMs,
    medianMs: median,
    thresholdMs,
  };
}

/* =====================================================================
 * Twin manifest builder + spawn callable shape.
 * ===================================================================== */

/**
 * Manifest the engine emits for the spawn callable to apply. The
 * operator's main.ts wires the callable to
 * `customApi.createNamespacedCustomObject` with this body. The
 * twin's name is derived from the primary's UID + a short suffix so
 * a second evaluation pass that races the apiserver doesn't create a
 * second twin (`AlreadyExists` is benign).
 *
 * The body includes:
 *   - `kagent.knuteson.io/speculative-twin: 'true'` label
 *   - `kagent.knuteson.io/speculative-primary-uid: <uid>` label
 *   - the primary's full `spec` (verbatim — same idempotencyKey,
 *     same inputs, same target Agent / capability)
 *
 * The owner reference is intentionally OMITTED — the twin is a peer,
 * not a child. (If the operator added an ownerRef, deleting the
 * primary would cascade-delete the twin mid-flight.)
 */
export interface TwinManifest {
  readonly apiVersion: string;
  readonly kind: 'AgentTask';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly spec: unknown;
}

/**
 * Per-AgentTask spec field signature the engine knows about. The
 * operator's CRD types model the full spec; the engine only needs
 * `idempotencyKey` for its decision and otherwise threads the
 * spec opaquely.
 */
function readIdempotencyKey(task: AffinityTask): string | undefined {
  const spec: unknown = task.spec;
  if (typeof spec !== 'object' || spec === null) return undefined;
  const k = (spec as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof k === 'string' && k.length > 0 ? k : undefined;
}

/**
 * Build the twin manifest from the primary task. Pure — the
 * operator's `spawnTwin` callable applies it via
 * `customApi.createNamespacedCustomObject`.
 *
 * Naming convention: `kts-<primary-uid-prefix>` (kts = "kagent task
 * speculative") so a deterministic re-evaluation never creates two
 * twins for the same primary. The primary's existing labels are
 * carried through (so observers like job-watch keep linking by
 * `kagent.knuteson.io/agent`) plus the two new locality labels.
 */
export function buildTwinManifest(primary: AffinityTask, apiVersion: string): TwinManifest {
  const uid = primary.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error('cannot build speculative twin: primary AgentTask has no metadata.uid');
  }
  const namespace = primary.metadata.namespace ?? 'default';
  const twinName = `kts-${uid.slice(0, 56)}`;
  const labels: Record<string, string> = {
    ...(primary.metadata.labels ?? {}),
    [SPECULATIVE_TWIN_LABEL]: 'true',
    [SPECULATIVE_PRIMARY_UID_LABEL]: uid,
  };
  // We threadthrough annotations only when present so a fresh CR
  // doesn't pick up admission-mutation-injected metadata.
  const ann = primary.metadata.annotations;
  return {
    apiVersion,
    kind: 'AgentTask',
    metadata: {
      name: twinName,
      namespace,
      labels,
      ...(ann !== undefined && { annotations: { ...ann } }),
    },
    spec: (primary as { spec: unknown }).spec,
  };
}

/**
 * Spawn callable — the engine's only point of contact with the
 * world. Returns the apiserver's status verbatim (best-effort);
 * `AlreadyExists` is logged but never thrown by the caller. Tests
 * inject a spy.
 */
export type SpawnTwinFn = (manifest: TwinManifest) => Promise<void>;

/**
 * Audit hooks — the engine fires these when it spawns a twin OR
 * marks a loser `superseded`. Best-effort by contract; the engine
 * NEVER throws on hook failure (the caller's audit publisher
 * already swallows its own errors).
 */
export interface SpeculativeAuditHooks {
  readonly emitSpawned?: (fields: SpeculativeSpawnedFields) => Promise<void>;
  readonly emitSuperseded?: (fields: SpeculativeSupersededFields) => Promise<void>;
}

export interface SpeculativeSpawnedFields {
  readonly primaryTaskUid: string;
  readonly primaryTaskNamespace: string;
  readonly primaryTaskName: string;
  readonly twinTaskName: string;
  readonly agentName: string;
  readonly elapsedMs: number;
  readonly medianMs: number;
  readonly thresholdMs: number;
}

export interface SpeculativeSupersededFields {
  readonly loserTaskUid: string;
  readonly loserTaskNamespace: string;
  readonly loserTaskName: string;
  readonly winnerTaskUid: string;
  readonly agentName: string;
}
