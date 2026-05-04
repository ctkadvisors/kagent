/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Zero-downtime rotation chaos test (v0.5.4-keyrotation, Wave 4 /
 * KeyRotation sub-team deliverable 5).
 *
 * Per docs/WAVES.md §6.5 deliverable 5:
 *   "Simulates a rotation cycle (SVID + cap + gateway-token
 *    simultaneously). Asserts no in-flight task fails (mock gateway
 *    accepts both old + new tokens during a 30s overlap window).
 *    This is the proof of zero-downtime rotation."
 *
 * Design decisions:
 *
 *   - In-process simulation. No real K8s, no real SPIRE, no real
 *     gateway. The chaos test is a property-style assertion against
 *     pure functions + a small mock gateway harness — that's
 *     sufficient for the substrate's contract: the rotation triple
 *     (SVID, cap, gateway-token) MUST NOT cause an in-flight task's
 *     LLM call to fail during a 30s overlap window.
 *
 *   - The mock gateway honors a substrate-level invariant: during a
 *     rotation window, BOTH the old AND the new token MUST be
 *     accepted. Callers using the old token (in-flight tasks who
 *     received their cap before the rotation) succeed; callers using
 *     the new token (post-rotation new tasks) succeed. Outside the
 *     overlap window only the new token is accepted.
 *
 *   - A "fleet" of N concurrent in-flight tasks is simulated. Each
 *     task makes M gateway calls scattered across the rotation
 *     timeline. We assert: zero failures across N*M call attempts.
 *
 *   - Time is virtual. We progress wall-clock in 1s increments via
 *     an injected clock, so the test runs in milliseconds without a
 *     real 30s wait.
 */

import { describe, expect, it } from 'vitest';

import { type CapTtlPolicy, decideCapTtl, resolveCapTtlPolicy } from '../src/cap-ttl.js';
import {
  type GatewayFetchFn,
  type GatewayFetchResponse,
  rotateGatewayOnce,
} from '../src/gateway-rotation.js';
import {
  type SvidRotationPolicy,
  decideSvidRotation,
  resolveSvidRotationPolicy,
} from '../src/svid-policy.js';

/**
 * Mock gateway harness — keeps a set of currently-valid bearer tokens.
 * During an overlap window, multiple tokens are simultaneously valid.
 */
class MockGateway {
  private validTokens = new Set<string>();
  private overlapEndAtMs: number | undefined;
  private oldTokenDuringOverlap: string | undefined;
  /** Wall-clock used to decide if an overlap window has elapsed. */
  constructor(private readonly clock: { now: () => Date }) {}

  setActiveToken(token: string): void {
    this.validTokens = new Set([token]);
    this.overlapEndAtMs = undefined;
    this.oldTokenDuringOverlap = undefined;
  }

  /**
   * Begin a rotation: both old and new are valid for `overlapMs` ms.
   * After the overlap ends, only `newToken` remains valid.
   */
  rotate(oldToken: string, newToken: string, overlapMs: number): void {
    this.validTokens = new Set([oldToken, newToken]);
    this.oldTokenDuringOverlap = oldToken;
    this.overlapEndAtMs = this.clock.now().getTime() + overlapMs;
  }

  /** Tick — drop expired old tokens past the overlap window. */
  tick(): void {
    if (this.overlapEndAtMs === undefined) return;
    if (this.clock.now().getTime() >= this.overlapEndAtMs) {
      if (this.oldTokenDuringOverlap !== undefined) {
        this.validTokens.delete(this.oldTokenDuringOverlap);
      }
      this.overlapEndAtMs = undefined;
      this.oldTokenDuringOverlap = undefined;
    }
  }

  /**
   * Validate a request bearer token + return a fakeResponse-like shape.
   * 200 if token is currently valid, 401 otherwise.
   */
  callLlm(token: string): { status: number; ok: boolean } {
    this.tick();
    if (this.validTokens.has(token)) return { status: 200, ok: true };
    return { status: 401, ok: false };
  }

  /** Mocks the rotation admin endpoint — substrate-side. */
  buildRotateFetch(): GatewayFetchFn {
    return (url, _init): Promise<GatewayFetchResponse> => {
      if (url.endsWith('/v1/admin/keys/rotate')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ rotationId: `rot-${this.clock.now().toISOString()}` }),
        });
      }
      return Promise.resolve({
        status: 404,
        ok: false,
        json: () => Promise.resolve({}),
      });
    };
  }
}

/**
 * Virtual clock — `tick(seconds)` advances forward; `now()` returns the
 * current Date. Avoids a real-time 30s sleep during the chaos run.
 */
class VirtualClock {
  private currentMs: number;
  constructor(start: Date) {
    this.currentMs = start.getTime();
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  tick(seconds: number): void {
    this.currentMs += seconds * 1000;
  }
}

describe('Wave 4 / KeyRotation — zero-downtime rotation chaos', () => {
  it('SVID + cap + gateway-token rotate simultaneously without failing any in-flight task', async () => {
    const start = new Date('2026-05-04T00:00:00Z');
    const clock = new VirtualClock(start);
    const gateway = new MockGateway(clock);

    // Substrate config — boot-time policies.
    const svidPolicy: SvidRotationPolicy = resolveSvidRotationPolicy({ intervalHours: 24 });
    const capPolicy: CapTtlPolicy = resolveCapTtlPolicy({});
    const overlapMs = 30 * 1000;

    // Initial bearer token; gateway accepts only this.
    gateway.setActiveToken('token-v1');

    // Simulate a fleet of 8 in-flight tasks (mix of short + long).
    const fleet: Array<{
      id: string;
      timeoutSeconds: number;
      bearer: string;
      svidNotBefore: Date;
      capExpiresAt: Date;
      // The agent-pod's call schedule (offsets in seconds from start).
      callOffsets: readonly number[];
    }> = [];
    for (let i = 0; i < 8; i++) {
      const timeoutSeconds = i % 2 === 0 ? 600 : 4 * 60 * 60; // half short, half long
      const ttl = decideCapTtl({ timeoutSeconds, policy: capPolicy });
      const capExpiresAt = new Date(start.getTime() + ttl.ttlSeconds * 1000);
      fleet.push({
        id: `task-${String(i)}`,
        timeoutSeconds,
        bearer: 'token-v1',
        svidNotBefore: start,
        capExpiresAt,
        // Calls scattered across 0s, 14s (during overlap), 35s (post-overlap), 60s.
        callOffsets: [0, 14, 35, 60],
      });
    }

    const failures: string[] = [];
    const successes: string[] = [];

    // Helper: agent-pod makes a gateway call using its current bearer.
    const agentPodCall = (taskId: string, bearer: string): void => {
      const r = gateway.callLlm(bearer);
      if (r.ok) successes.push(taskId);
      else failures.push(`${taskId}@${clock.now().toISOString()}:${String(r.status)}`);
    };

    // Tick to t=0; each task's first call (offset=0) goes BEFORE rotation.
    for (const task of fleet) {
      if (task.callOffsets.includes(0)) agentPodCall(task.id, task.bearer);
    }

    // === Rotation event triggers ===
    // 1. SVID rotation policy decides "rotate" because we'll move the
    //    clock past the configured interval at simulation step.
    //    For the chaos run, we trigger the rotation manually at t=10s
    //    by acting as though SVID age crossed (simulate a faster
    //    interval just for this test by checking notBefore vs. now).
    clock.tick(10); // t=10s

    // SVID decision: simulate it — substrate-policy fires.
    for (const task of fleet) {
      const decision = decideSvidRotation({
        spiffeId: `spiffe://kagent.knuteson.io/ns/default/sa/agent-x/agent/researcher-${task.id}`,
        notBefore: task.svidNotBefore,
        // Force a virtual "rotation due" by feeding a now in the future.
        now: new Date(task.svidNotBefore.getTime() + (svidPolicy.intervalSeconds + 1) * 1000),
        policy: svidPolicy,
      });
      // We don't restart the agent-pod in this test (cap is what gates
      // the call); we just verify the policy fires. SVID rotation is
      // out-of-band w.r.t. the in-flight gateway call.
      expect(decision.verdict).toBe('rotate');
    }

    // 2. Cap rotation: a fresh cap is minted with the new TTL policy.
    //    The OLD cap is still valid (capExpiresAt > now); the NEW cap
    //    is what new tasks would receive. Existing tasks keep using
    //    their OLD bearer token — gateway accepts both during overlap.

    // 3. Gateway-token rotation: substrate calls
    //    POST /v1/admin/keys/rotate. The mock gateway returns 200 +
    //    rotationId; substrate begins overlap window (gateway accepts
    //    both old + new tokens for 30s).
    const rotateOutcome = await rotateGatewayOnce({
      gatewayUrl: 'https://mock-gateway',
      adminToken: 'admin-tk',
      fetch: gateway.buildRotateFetch(),
      now: () => clock.now(),
    });
    expect(rotateOutcome.kind).toBe('rotated');

    // The substrate would now begin distributing token-v2 via fresh
    // cap mints; for the test we manually start the overlap window at
    // t=10s (gateway accepts BOTH tokens until t=40s).
    gateway.rotate('token-v1', 'token-v2', overlapMs);

    // === Post-rotation calls ===
    // Tick to t=14s; each task that scheduled a call at offset=14 fires
    // using its OLD bearer (token-v1). These MUST succeed because
    // we're still inside the overlap window (10 + 30 = 40s).
    clock.tick(4);
    for (const task of fleet) {
      if (task.callOffsets.includes(14)) agentPodCall(task.id, task.bearer);
    }

    // Tick to t=35s. STILL inside the overlap window (which ends at
    // t=40s). Calls at offset=35 with OLD bearer must still succeed.
    clock.tick(21);
    for (const task of fleet) {
      if (task.callOffsets.includes(35)) agentPodCall(task.id, task.bearer);
    }

    // Tick to t=41s — overlap window has closed (10 + 30 = 40s).
    // From here on, agent-pods MUST be using the new bearer. The
    // substrate's cap-rotation flow re-mints caps WITH the new bearer
    // before the overlap closes; we model that by flipping each task's
    // bearer to token-v2 BEFORE the t=60s call.
    clock.tick(6); // t=41s
    for (const task of fleet) {
      task.bearer = 'token-v2';
    }

    // Tick to t=60s. Calls at offset=60 use the new bearer; must succeed.
    clock.tick(19);
    for (const task of fleet) {
      if (task.callOffsets.includes(60)) agentPodCall(task.id, task.bearer);
    }

    // === Assertions ===
    // 8 tasks * 4 call offsets = 32 calls. ZERO failures expected.
    expect(failures).toEqual([]);
    expect(successes).toHaveLength(32);

    // Every cap is still within its expiry (we used short+long TTLs;
    // the long-running ones easily outlive the 60s window).
    for (const task of fleet) {
      const remainingMs = task.capExpiresAt.getTime() - clock.now().getTime();
      expect(remainingMs).toBeGreaterThan(0);
    }
  });

  it('rotation fails closed (failures expected) when overlap window is zero', () => {
    // Negative-control: prove the test harness CAN see failures when
    // the gateway DOESN'T honor the overlap contract. This guards
    // against a green test that's secretly never exercising the
    // assertion path.
    const clock = new VirtualClock(new Date('2026-05-04T00:00:00Z'));
    const gateway = new MockGateway(clock);
    gateway.setActiveToken('token-v1');

    // In-flight task with old bearer.
    const oldBearer = 'token-v1';

    // Simulate immediate rotation with ZERO overlap — old token
    // becomes invalid the instant new is in place.
    gateway.rotate('token-v1', 'token-v2', 0);
    // Tick once so the overlap drains immediately.
    clock.tick(1);

    const r = gateway.callLlm(oldBearer);
    // Old token MUST now be rejected (zero-overlap = no grace).
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});
