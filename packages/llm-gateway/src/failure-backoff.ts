/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-(model, backendUrl) failure circuit for provider dispatch.
 *
 * AIMD handles normal capacity pressure. This circuit handles a
 * different class: repeated provider failures where another identical
 * request is known-bad (for example Cloudflare "No such model" 400s).
 * Once the threshold trips, the gateway returns 503 + Retry-After
 * without calling the provider until the backoff window expires.
 */

export interface FailureBackoffOptions {
  readonly failureThreshold: number;
  readonly backoffSeconds: number;
  readonly clock?: () => number;
}

export interface FailureBackoffOpen {
  readonly ok: false;
  readonly retryAfterSec: number;
  readonly message: string;
}

export type FailureBackoffDecision = { readonly ok: true } | FailureBackoffOpen;

interface FailureState {
  consecutiveFailures: number;
  openUntilMs: number;
}

export class FailureBackoffController {
  private readonly failureThreshold: number;
  private readonly backoffMs: number;
  private readonly clock: () => number;
  private readonly map = new Map<string, FailureState>();

  constructor(opts: FailureBackoffOptions) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
      throw new Error('failureThreshold must be an integer >= 1');
    }
    if (!Number.isInteger(opts.backoffSeconds) || opts.backoffSeconds < 1) {
      throw new Error('backoffSeconds must be an integer >= 1');
    }
    this.failureThreshold = opts.failureThreshold;
    this.backoffMs = opts.backoffSeconds * 1000;
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  beforeRequest(model: string, backendUrl: string): FailureBackoffDecision {
    const key = this.key(model, backendUrl);
    const state = this.map.get(key);
    if (state === undefined) return { ok: true };
    const now = this.clock();
    if (state.openUntilMs > now) {
      const retryAfterSec = Math.max(1, Math.ceil((state.openUntilMs - now) / 1000));
      return {
        ok: false,
        retryAfterSec,
        message: `provider failure backoff open for ${model}`,
      };
    }
    if (state.openUntilMs > 0) {
      this.map.delete(key);
    }
    return { ok: true };
  }

  recordSuccess(model: string, backendUrl: string): void {
    this.map.delete(this.key(model, backendUrl));
  }

  recordFailure(model: string, backendUrl: string): void {
    const key = this.key(model, backendUrl);
    const state = this.map.get(key) ?? { consecutiveFailures: 0, openUntilMs: 0 };
    const consecutiveFailures = state.consecutiveFailures + 1;
    if (consecutiveFailures >= this.failureThreshold) {
      this.map.set(key, {
        consecutiveFailures,
        openUntilMs: this.clock() + this.backoffMs,
      });
      return;
    }
    this.map.set(key, { consecutiveFailures, openUntilMs: 0 });
  }

  private key(model: string, backendUrl: string): string {
    return `${model}|${backendUrl}`;
  }
}
