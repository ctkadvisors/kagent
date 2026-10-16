/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `safeRestart` — backoff-driven re-`start()` for `@kubernetes/client-node`
 * Informers that have emitted `error`.
 *
 * **Why this exists (H6).** The previous restart pattern at watch.ts:114
 * and job-watch.ts:124,137 was:
 *
 *     setTimeout(() => { void informer.start(); }, 5000);
 *
 * Three problems:
 *
 *   1. **Rejection silently dropped.** `void informer.start()` discards
 *      the promise's rejection; if the relist itself fails (apiserver
 *      down, RBAC stripped, network partition), the rejection is
 *      unobservable and the informer simply stops working.
 *   2. **Constant 5s backoff.** Apiserver under stress (admission
 *      webhook timeout, etcd flap) gets hammered every 5 seconds with
 *      no breathing room. A relist storm is a known apiserver-foot-gun.
 *   3. **No cap.** A permanently-broken watch (e.g., CRD removed
 *      mid-run) re-tries forever, generating noisy `console.error` per
 *      attempt. Operator looks healthy from `kubectl get pod` but is
 *      effectively dead — exactly the failure mode M21 is meant to
 *      surface but currently can't.
 *
 * `safeRestart` fixes all three: exponential backoff (5s → 10s → 20s
 * → 40s → 60s → 5min cap), explicit `.catch()` on `start()` that runs
 * the supplied error reporter, and a consecutive-failure cap that
 * triggers a terminal callback the operator can use to flip a
 * readiness probe (M21 groundwork — the cap-reached callback exists
 * here but no caller wires it to readyz today; that's W3-Operator's
 * scope).
 *
 * The helper is deliberately pure — no globals, no module-level state.
 * Each Informer gets its own restart-state object via `createRestarter`.
 * Tests inject a fake `setTimeout` + `Date.now` to drive the backoff
 * deterministically; production uses `globalThis.setTimeout` and the
 * standard clock.
 */

/** Minimal Informer surface needed to restart it. */
import type { Informer, KubernetesObject } from '@kubernetes/client-node';

export interface RestartableInformer {
  start(): Promise<void>;
}

/** Logger shape used by safeRestart — structured, not message-bag. */
export interface InformerRestartLogger {
  /**
   * Called every time a `start()` rejects. The caller decides whether
   * to log loudly (production: `console.error`) or quietly (tests).
   */
  onStartRejected(err: unknown, attempt: number, nextDelayMs: number): void;
  /**
   * Called once when the consecutive-failure cap is reached. Operator
   * wiring uses this to flip a readiness probe (M21 — not wired in
   * v0.1; the hook exists for W3-Operator).
   */
  onCapReached?(err: unknown, totalAttempts: number): void;
}

/** Configuration knobs for the backoff schedule. */
export interface RestartOptions {
  /** Initial delay before the first retry. Default 5000 ms. */
  readonly initialDelayMs?: number;
  /** Multiplier applied each consecutive failure. Default 2. */
  readonly backoffFactor?: number;
  /** Max delay between retries. Default 5 * 60 * 1000 ms (5 minutes). */
  readonly maxDelayMs?: number;
  /**
   * Cap on consecutive failures. After this many `start()` rejections
   * in a row, `onCapReached` fires and the restarter stops scheduling
   * more retries. Default 12 (with default schedule, ~30 minutes total
   * before giving up — long enough to ride out an apiserver upgrade,
   * short enough to surface a permanent break before SREs lose track).
   */
  readonly maxConsecutiveFailures?: number;
}

/**
 * Mutable state held per Informer. Public surface so tests can read
 * `attempts` to assert the backoff math without timing flakes. The
 * production code never inspects these fields.
 */
export interface RestarterState {
  /** Number of consecutive `start()` rejections since the last success. */
  attempts: number;
  /** Whether the cap has been reached and we've stopped scheduling. */
  capReached: boolean;
  /** Last delay scheduled (for test assertions). */
  lastDelayMs: number;
}

/** Injected timer shape (so tests don't sit on real time). */
export interface RestartTimer {
  setTimeout(cb: () => void, delayMs: number): void;
  /**
   * Process-level escalation once the consecutive-failure cap is reached.
   * Production ({@link PROCESS_TIMER}) exits so Kubernetes restarts the
   * operator with fresh watches. Before this existed, the 2026-10-16 network
   * outage capped the AgentTask watch and the pod stayed Running and Ready
   * while dispatching nothing for 33 minutes. Test timers omit it.
   */
  exit?(code: number): void;
}

/** Real timers plus exit-on-cap; the default for every production informer. */
export const PROCESS_TIMER: RestartTimer = {
  setTimeout: (cb, ms) => void globalThis.setTimeout(cb, ms),
  exit: (code) => process.exit(code),
};

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1_000; // 5 minutes
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 12;

/**
 * Build the backoff schedule for `attempt` (1-indexed). Exposed for
 * tests; never call this directly from production.
 */
export function computeBackoffMs(
  attempt: number,
  opts: Pick<RestartOptions, 'initialDelayMs' | 'backoffFactor' | 'maxDelayMs'> = {},
): number {
  const base = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const factor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const safeAttempt = Math.max(0, attempt - 1);
  const raw = base * Math.pow(factor, safeAttempt);
  return Math.min(raw, cap);
}

/**
 * Build a restarter for a single Informer. The returned `safeRestart`
 * function is what `informer.on('error', ...)` should invoke.
 *
 * **Idempotency.** Calling `safeRestart` while a retry is already
 * in-flight (i.e., a previous error fired but its scheduled `start()`
 * hasn't yet resolved/rejected) is allowed — the in-flight attempt
 * wins; the second invocation is a no-op. This matches the K8s client's
 * behavior of emitting multiple `error` events during a connection
 * storm.
 */
export function createRestarter(
  informer: RestartableInformer,
  logger: InformerRestartLogger,
  opts: RestartOptions = {},
  timer: RestartTimer = PROCESS_TIMER,
): {
  readonly state: RestarterState;
  safeRestart(err: unknown): void;
  /** Reset the state on a successful start. Currently unused — exposed for future M21 wiring. */
  reset(): void;
} {
  const max = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const state: RestarterState = {
    attempts: 0,
    capReached: false,
    lastDelayMs: 0,
  };
  let pending = false;

  function reset(): void {
    state.attempts = 0;
    state.capReached = false;
    state.lastDelayMs = 0;
    pending = false;
  }

  function safeRestart(err: unknown): void {
    if (state.capReached) return;
    if (pending) return;
    state.attempts += 1;
    if (state.attempts > max) {
      state.capReached = true;
      logger.onCapReached?.(err, state.attempts);
      timer.exit?.(1);
      return;
    }
    const delayMs = computeBackoffMs(state.attempts, opts);
    state.lastDelayMs = delayMs;
    pending = true;
    timer.setTimeout(() => {
      // The `start()` promise CAN reject (relist 401/404/connection
      // refused). Catch the rejection and feed it back through
      // safeRestart so the backoff escalates instead of silently
      // dropping. On success, leave `attempts` non-zero — the next
      // `error` event will reset the schedule via `reset()` once
      // M21 wires explicit "watch healthy" detection. Until then,
      // staying on the elevated backoff is safe (no apiserver harm
      // beyond a slightly slower recovery on transient flaps).
      informer.start().then(
        () => {
          pending = false;
        },
        (startErr: unknown) => {
          pending = false;
          logger.onStartRejected(startErr, state.attempts, delayMs);
          safeRestart(startErr);
        },
      );
    }, delayMs);
  }

  return { state, safeRestart, reset };
}

/**
 * The restart policy every operator informer uses: exponential backoff,
 * reset on any delivered event, and exit at the consecutive-failure cap so
 * Kubernetes restarts the operator with fresh watches. Replaces the bare
 * `setTimeout(() => void informer.start(), 5000)`, whose swallowed rejection
 * left a watch dead with no further error event.
 */
export function superviseInformer<T extends KubernetesObject>(
  label: string,
  informer: Informer<T>,
  timer: RestartTimer = PROCESS_TIMER,
): void {
  const restarter = createRestarter(
    informer,
    {
      onStartRejected(err, attempt, nextDelayMs) {
        console.error(
          `${label} start() rejected (attempt ${attempt.toString()}, next delay ${nextDelayMs.toString()}ms):`,
          err,
        );
      },
      onCapReached(err, totalAttempts) {
        console.error(
          `${label} restart cap reached after ${totalAttempts.toString()} failures; exiting so Kubernetes restarts the operator:`,
          err,
        );
      },
    },
    {},
    timer,
  );
  informer.on('add', () => {
    restarter.reset();
  });
  informer.on('update', () => {
    restarter.reset();
  });
  informer.on('error', (err) => {
    console.error(`${label} error:`, err);
    restarter.safeRestart(err);
  });
}
