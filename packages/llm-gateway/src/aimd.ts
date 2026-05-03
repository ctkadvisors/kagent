/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AIMD (Additive Increase / Multiplicative Decrease) self-tuning of
 * the per-(model, endpoint) in-flight cap. Implements §3.5 of the
 * gateway design spec:
 *
 *   on success_response:
 *     if (consecutive_clean_window_seconds >= 60) and (current_cap < endpoint.max):
 *       current_cap += 1
 *
 *   on 429 / error / latency-spike:
 *     current_cap = max(endpoint.minSafe, floor(current_cap / 2))
 *
 *   latency-spike := latency_ms > 2 * rolling_p50(last 5 min)
 *
 * Bounds (`seed`, `max`, `minSafe`) come from the ModelEndpoint CRD;
 * the gateway WRITES `current_cap` back to `status.observedInFlight`
 * so the operator's admission reconciler queues against the live cap,
 * not the static seed.
 *
 * State is per-Pod and in-memory — single-replica v1 design. On Pod
 * restart the cap reconverges in ~10 minutes via additive increase
 * (acceptable per spec §3.5 + §6).
 */

export interface AimdBounds {
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
}

export interface AimdOptions extends AimdBounds {
  /** Min ms of clean traffic before the next additive bump. Default 60s. */
  readonly cleanWindowMs?: number;
  /** Latency spike multiplier vs rolling p50. Default 2x. */
  readonly latencySpikeMultiplier?: number;
  /** Rolling-window samples kept per key for p50. Default 50. */
  readonly latencyWindowSize?: number;
  /** Test-injectable clock. Production uses `Date.now`. */
  readonly clock?: () => number;
}

export interface AimdSnapshotEntry {
  readonly model: string;
  readonly endpoint: string;
  readonly cap: number;
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
  readonly recentP50Ms: number | null;
  readonly windowStartedAt: number;
}

interface PerKeyState {
  cap: number;
  bounds: AimdBounds;
  /** Latency samples used to estimate rolling p50. */
  latencies: number[];
  /** Timestamp the current "clean" window opened (ms epoch). */
  windowStartedAt: number;
  /**
   * False until the first explicit `updateBounds` call. Lets us
   * distinguish a freshly-ensured entry (cap === controller default
   * seed) from a long-running one whose cap reflects observed
   * traffic. The first updateBounds reseeds cap to the per-endpoint
   * spec.seed; subsequent calls only re-clamp to the new max/minSafe.
   */
  seededFromEndpoint: boolean;
}

const DEFAULT_CLEAN_WINDOW_MS = 60_000;
const DEFAULT_LATENCY_SPIKE_MULTIPLIER = 2;
const DEFAULT_LATENCY_WINDOW_SIZE = 50;

export class AimdController {
  private readonly defaults: AimdBounds;
  private readonly cleanWindowMs: number;
  private readonly latencySpikeMultiplier: number;
  private readonly latencyWindowSize: number;
  private readonly clock: () => number;
  private readonly map = new Map<string, PerKeyState>();

  constructor(opts: AimdOptions) {
    this.defaults = { seed: opts.seed, max: opts.max, minSafe: opts.minSafe };
    this.cleanWindowMs = opts.cleanWindowMs ?? DEFAULT_CLEAN_WINDOW_MS;
    this.latencySpikeMultiplier = opts.latencySpikeMultiplier ?? DEFAULT_LATENCY_SPIKE_MULTIPLIER;
    this.latencyWindowSize = opts.latencyWindowSize ?? DEFAULT_LATENCY_WINDOW_SIZE;
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  /**
   * Replace the per-key bounds (called by the router on every request
   * with the latest CR observation). On the first call for a key, the
   * cap is reseeded to `bounds.seed` so a fresh model starts at its
   * spec-configured seed rather than the controller's default. On
   * subsequent calls, only re-clamp to the new max/minSafe — preserves
   * the AIMD-tuned cap across CR re-writes that don't change bounds.
   */
  updateBounds(model: string, endpoint: string, bounds: AimdBounds): void {
    const state = this.ensure(model, endpoint);
    state.bounds = bounds;
    if (!state.seededFromEndpoint) {
      state.cap = bounds.seed;
      state.seededFromEndpoint = true;
    }
    if (state.cap > bounds.max) state.cap = bounds.max;
    if (state.cap < bounds.minSafe) state.cap = bounds.minSafe;
  }

  /** Current cap for a (model, endpoint). Seeds on first access. */
  currentCap(model: string, endpoint: string): number {
    return this.ensure(model, endpoint).cap;
  }

  /**
   * Record a successful response. If both:
   *   - cleanWindowMs has elapsed since the last error or last bump, AND
   *   - latencyMs is not a spike vs the rolling p50,
   * then additively increase the cap by 1 (clamped at max).
   */
  onSuccess(model: string, endpoint: string, latencyMs: number): void {
    const state = this.ensure(model, endpoint);
    const now = this.clock();

    // Spike check uses the EXISTING window before this sample is added —
    // a single spiky sample shouldn't get diluted by adding itself first.
    const p50Before = computeP50(state.latencies);
    pushBounded(state.latencies, latencyMs, this.latencyWindowSize);

    if (
      p50Before !== null &&
      latencyMs > p50Before * this.latencySpikeMultiplier &&
      state.cap > state.bounds.minSafe
    ) {
      state.cap = Math.max(state.bounds.minSafe, Math.floor(state.cap / 2));
      state.windowStartedAt = now;
      return;
    }

    if (now - state.windowStartedAt >= this.cleanWindowMs && state.cap < state.bounds.max) {
      state.cap += 1;
      state.windowStartedAt = now;
    }
  }

  /**
   * Record a backend error / 429. Halves the cap (floor) clamped at
   * minSafe, and resets the clean-window so the next additive increase
   * requires a fresh full window of error-free responses.
   */
  onError(model: string, endpoint: string): void {
    const state = this.ensure(model, endpoint);
    state.cap = Math.max(state.bounds.minSafe, Math.floor(state.cap / 2));
    state.windowStartedAt = this.clock();
  }

  snapshot(): readonly AimdSnapshotEntry[] {
    const out: AimdSnapshotEntry[] = [];
    for (const [key, state] of this.map) {
      const sep = key.indexOf('|');
      out.push({
        model: key.slice(0, sep),
        endpoint: key.slice(sep + 1),
        cap: state.cap,
        seed: state.bounds.seed,
        max: state.bounds.max,
        minSafe: state.bounds.minSafe,
        recentP50Ms: computeP50(state.latencies),
        windowStartedAt: state.windowStartedAt,
      });
    }
    out.sort((a, b) => {
      if (a.model !== b.model) return a.model < b.model ? -1 : 1;
      return a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;
    });
    return out;
  }

  private ensure(model: string, endpoint: string): PerKeyState {
    const key = `${model}|${endpoint}`;
    let state = this.map.get(key);
    if (state === undefined) {
      state = {
        cap: this.defaults.seed,
        bounds: { ...this.defaults },
        latencies: [],
        windowStartedAt: this.clock(),
        seededFromEndpoint: false,
      };
      this.map.set(key, state);
    }
    return state;
  }
}

function pushBounded(arr: number[], v: number, max: number): void {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

function computeP50(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? null;
}
