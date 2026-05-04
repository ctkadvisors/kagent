/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Gateway-token rotation API integration (v0.5.4-keyrotation,
 * Wave 4 / KeyRotation sub-team).
 *
 * Per docs/GATEWAY-CONTRACT.md §4, the gateway-side token rotation
 * surface is `POST /v1/admin/keys/rotate`. The CTK enterprise gateway
 * implements this; the OSS LiteLLM Proxy currently does NOT, and the
 * substrate must gracefully no-op against an unsupporting gateway:
 *
 *   - 2xx → emit `keyrotation.gateway_rotated` (success)
 *   - 404 → emit `keyrotation.gateway_unsupported` (graceful no-op,
 *           gateway is behind on the contract version)
 *   - other non-2xx → log + retry on next cadence (no audit emission;
 *                     transient errors aren't substrate-policy decisions)
 *   - network failure → log + retry on next cadence
 *
 * Cadence: scheduled via `scheduleGatewayRotation(...)`; default 24h
 * (Helm `keyRotation.gateway.intervalHours`).
 *
 * The rotation request body is empty (the gateway doesn't need
 * substrate-supplied material to rotate ITS keys); the gateway's
 * response is opaque to the substrate beyond its status code +
 * optional `rotationId` field.
 */

/**
 * Default rotation cadence = 24 hours, in milliseconds.
 */
export const DEFAULT_GATEWAY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Outcome of a single rotation attempt.
 */
export type GatewayRotationOutcome =
  | { readonly kind: 'rotated'; readonly rotationId: string | undefined; readonly observedAt: Date }
  | { readonly kind: 'unsupported'; readonly status: number; readonly observedAt: Date }
  | { readonly kind: 'transient_error'; readonly reason: string; readonly observedAt: Date };

/**
 * Subset of the global `fetch` we depend on. Tests inject a stub that
 * returns predetermined Response shapes without standing up a real
 * gateway.
 */
export type GatewayFetchFn = (
  input: string,
  init?: GatewayFetchInit,
) => Promise<GatewayFetchResponse>;

export interface GatewayFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Subset of the WHATWG `Response` we read. The gateway returns either
 * `{ rotationId: '...' }` or an empty body; we accept both. Reading
 * `.json()` throws on non-JSON; the rotation client treats that as a
 * graceful no-op (the rotation succeeded, we just don't have an id).
 */
export interface GatewayFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/**
 * Inputs to a rotation attempt. The base URL is the gateway's root
 * (e.g. `https://litellm.kagent-system.svc.cluster.local`); the
 * client appends `/v1/admin/keys/rotate`.
 */
export interface RotateGatewayInput {
  /** Gateway base URL — no trailing slash. */
  readonly gatewayUrl: string;
  /**
   * Admin bearer token for the rotation endpoint. The substrate
   * sources this from a K8s Secret via env (
   * `KAGENT_KEYROTATION_GATEWAY_ADMIN_TOKEN`); production deployments
   * MUST scope this token to `keys:rotate` only.
   */
  readonly adminToken: string;
  /** Injectable fetch impl for tests. */
  readonly fetch?: GatewayFetchFn;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

/**
 * Perform a single rotation attempt. Returns one of three outcomes.
 *
 * Wire shape:
 *   POST <gatewayUrl>/v1/admin/keys/rotate
 *   Authorization: Bearer <adminToken>
 *   Content-Type: application/json
 *   (empty body)
 *
 * The function NEVER throws — graceful-fail-open is the substrate
 * contract. A network error returns `{ kind: 'transient_error', ... }`
 * so the caller can log + retry on next cadence without an exception
 * propagating into the operator's reconcile loop.
 */
export async function rotateGatewayOnce(
  input: RotateGatewayInput,
): Promise<GatewayRotationOutcome> {
  const fetchFn = input.fetch ?? defaultFetch;
  const now = input.now ?? defaultNow;
  const url = `${input.gatewayUrl.replace(/\/$/, '')}/v1/admin/keys/rotate`;
  let response: GatewayFetchResponse;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    return {
      kind: 'transient_error',
      reason: err instanceof Error ? err.message : 'unknown_fetch_error',
      observedAt: now(),
    };
  }
  if (response.status === 404) {
    return { kind: 'unsupported', status: 404, observedAt: now() };
  }
  if (response.ok) {
    let rotationId: string | undefined;
    try {
      const body = await response.json();
      if (typeof body === 'object' && body !== null && 'rotationId' in body) {
        const candidate = (body as Record<string, unknown>).rotationId;
        if (typeof candidate === 'string') rotationId = candidate;
      }
    } catch {
      // Empty / non-JSON body is fine; rotation succeeded without id.
      rotationId = undefined;
    }
    return { kind: 'rotated', rotationId, observedAt: now() };
  }
  return {
    kind: 'transient_error',
    reason: `gateway_status_${response.status.toString()}`,
    observedAt: now(),
  };
}

/**
 * Inputs for `scheduleGatewayRotation` — wires the periodic timer.
 */
export interface ScheduleGatewayRotationInput {
  readonly gatewayUrl: string;
  readonly adminToken: string;
  /** Cadence in ms; defaults to DEFAULT_GATEWAY_ROTATION_INTERVAL_MS. */
  readonly intervalMs?: number;
  /**
   * Outcome callback. The operator's main.ts wires this to the audit
   * publisher: emits `keyrotation.gateway_rotated` on `'rotated'`,
   * `keyrotation.gateway_unsupported` on `'unsupported'`, and a
   * `console.warn` on `'transient_error'` (no audit event for
   * transients — they're not substrate-policy decisions).
   */
  readonly onOutcome?: (outcome: GatewayRotationOutcome) => Promise<void> | void;
  /** Injectable for tests. */
  readonly fetch?: GatewayFetchFn;
  /** Injectable for tests. */
  readonly now?: () => Date;
  /** Test-only: skip the initial-tick run-on-boot. */
  readonly skipInitialTick?: boolean;
}

/**
 * Returns a stop function. Production callers stash the stop in
 * `onShutdownExtra` so the operator's graceful shutdown path tears
 * the timer down.
 */
export interface ScheduledGatewayRotation {
  readonly stop: () => void;
}

/**
 * Schedule periodic rotation. Calls `rotateGatewayOnce` once per
 * interval; the first call fires immediately on boot UNLESS
 * `skipInitialTick=true`.
 *
 * Pure transport — no audit emission here. The `onOutcome` callback
 * is the operator's hook into the audit pipeline.
 */
export function scheduleGatewayRotation(
  input: ScheduleGatewayRotationInput,
): ScheduledGatewayRotation {
  const intervalMs = input.intervalMs ?? DEFAULT_GATEWAY_ROTATION_INTERVAL_MS;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    const outcome = await rotateGatewayOnce({
      gatewayUrl: input.gatewayUrl,
      adminToken: input.adminToken,
      ...(input.fetch !== undefined && { fetch: input.fetch }),
      ...(input.now !== undefined && { now: input.now }),
    });
    if (input.onOutcome !== undefined) {
      try {
        await input.onOutcome(outcome);
      } catch (err) {
        console.warn('[kagent-keyrotation] onOutcome failed:', err);
      }
    }
    if (cancelled) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  if (input.skipInitialTick === true) {
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  } else {
    void tick();
  }

  return {
    stop: () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/* =====================================================================
 * Internals
 * ===================================================================== */

function defaultFetch(input: string, init?: GatewayFetchInit): Promise<GatewayFetchResponse> {
  // The global `fetch` is available in Node 22+ (undici-backed). The
  // Response object satisfies the GatewayFetchResponse subset we read.
  const requestInit: RequestInit = {
    method: init?.method ?? 'GET',
    ...(init?.headers !== undefined && { headers: { ...init.headers } }),
    ...(init?.body !== undefined && { body: init.body }),
  };
  return globalThis.fetch(input, requestInit);
}

function defaultNow(): Date {
  return new Date();
}
