/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Substrate health surface — M21.
 *
 * Three pieces, all best-effort:
 *
 *   1. {@link InformerHealth.recordEvent} — informers call this on
 *      every observed `add` / `update` / `delete` so the freshness
 *      timestamp stays current. The `/healthz` endpoint flips to 500
 *      after {@link DEFAULT_INFORMER_FRESHNESS_MAX_MS} (5 min) of
 *      silence.
 *
 *   2. {@link InformerHealth.recordError} — informers call this from
 *      their `onError` handler. Increments
 *      `kagent_operator_informer_errors_total` and emits a structured
 *      `substrate.informer_error` log line so operators can pattern-
 *      match it without parsing free-form text.
 *
 *      NOTE — the audit-events catalog (`@kagent/audit-events`) is
 *      out-of-scope for the M21 wave. The structured stdout shape is
 *      a stop-gap until a v0.2 minor-bump adds
 *      `substrate.informer_error` to the union; the format is
 *      deliberately easy to swap for `auditPublisher.publish(...)`
 *      once that lands. (Same forward-compat shape the Blackboard GC
 *      audit uses at `main.ts:1838`.)
 *
 *   3. {@link startSubstrateHealthServer} — boots a tiny `node:http`
 *      server on the configured port (env `KAGENT_HEALTHZ_PORT`,
 *      default 8081) exposing `/healthz` (200 OK / 500 STALE) and
 *      `/metrics` (Prometheus text format,
 *      `kagent_operator_informer_errors_total`). Closeable on SIGTERM.
 */

import * as http from 'node:http';

export const INFORMER_ERRORS_METRIC = 'kagent_operator_informer_errors_total' as const;

/** 5 minutes — operator's window before /healthz flips to 500. */
export const DEFAULT_INFORMER_FRESHNESS_MAX_MS = 5 * 60 * 1000;

export const SUBSTRATE_INFORMER_ERROR_LOG_PREFIX = '[kagent-operator/substrate.informer_error]';

/**
 * Per-informer health tracker. The operator constructs ONE instance
 * shared across the AgentTask + Job + Pod informers (and any future
 * controllers); each informer calls `recordEvent` on every observed
 * event and `recordError` on watch errors.
 */
export interface InformerHealth {
  /** Mark the substrate as having seen a fresh event from any informer. */
  recordEvent(source: string): void;
  /** Mark an informer error and emit `substrate.informer_error`. */
  recordError(source: string, err: unknown): void;
  /** Wall-clock ms since the last recorded event (Infinity if never). */
  msSinceLastEvent(): number;
  /** Total observed informer errors since process start. */
  errorsTotal(): number;
}

export interface InformerHealthOptions {
  /** Inject a clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Inject a logger sink for tests; defaults to `console`. */
  readonly logger?: { error: (...args: unknown[]) => void };
}

export function createInformerHealth(opts: InformerHealthOptions = {}): InformerHealth {
  const now = opts.now ?? (() => Date.now());
  const logger = opts.logger ?? console;
  let lastEventMs: number | undefined;
  let errorsTotal = 0;
  return {
    recordEvent(): void {
      lastEventMs = now();
    },
    recordError(source: string, err: unknown): void {
      errorsTotal++;
      const message = err instanceof Error ? err.message : String(err);
      // Structured log line — easy to grep (`substrate.informer_error`
      // is a stable token) and easy to swap for an `auditPublisher`
      // emission once the audit-events catalog adds the type.
      logger.error(
        `${SUBSTRATE_INFORMER_ERROR_LOG_PREFIX} source=${source} errors_total=${errorsTotal.toString()} message=${JSON.stringify(message)}`,
      );
    },
    msSinceLastEvent(): number {
      if (lastEventMs === undefined) return Infinity;
      return Math.max(0, now() - lastEventMs);
    },
    errorsTotal(): number {
      return errorsTotal;
    },
  };
}

/**
 * `/healthz` decision shape. Pure for unit testing; the HTTP handler
 * wraps it.
 */
export type HealthzDecision =
  | { readonly status: 200; readonly reason: 'ok' }
  | { readonly status: 503; readonly reason: 'never-synced' }
  | { readonly status: 503; readonly reason: 'stale'; readonly stalenessMs: number };

export function decideHealthz(
  health: InformerHealth,
  freshnessMaxMs: number = DEFAULT_INFORMER_FRESHNESS_MAX_MS,
): HealthzDecision {
  const ms = health.msSinceLastEvent();
  if (ms === Infinity) {
    return { status: 503, reason: 'never-synced' };
  }
  if (ms > freshnessMaxMs) {
    return { status: 503, reason: 'stale', stalenessMs: ms };
  }
  return { status: 200, reason: 'ok' };
}

/** Render the Prometheus text-format metrics snapshot. */
export function renderMetricsText(health: InformerHealth): string {
  return [
    `# HELP ${INFORMER_ERRORS_METRIC} Total informer error events observed since operator boot.`,
    `# TYPE ${INFORMER_ERRORS_METRIC} counter`,
    `${INFORMER_ERRORS_METRIC} ${health.errorsTotal().toString()}`,
    '',
  ].join('\n');
}

export interface SubstrateHealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface StartSubstrateHealthServerOptions {
  readonly port?: number;
  readonly freshnessMaxMs?: number;
}

/**
 * Boot a minimal HTTP server exposing `/healthz` and `/metrics`. Best
 * effort — bind failures (port-in-use) log a warning and return an
 * `undefined` handle; production boot continues. The chart wires
 * `KAGENT_HEALTHZ_PORT` and adds a livenessProbe on a follow-up
 * release.
 */
export async function startSubstrateHealthServer(
  health: InformerHealth,
  opts: StartSubstrateHealthServerOptions = {},
): Promise<SubstrateHealthServer | undefined> {
  const port = opts.port ?? 8081;
  const freshnessMaxMs = opts.freshnessMaxMs ?? DEFAULT_INFORMER_FRESHNESS_MAX_MS;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz' || url.startsWith('/healthz?')) {
      const decision = decideHealthz(health, freshnessMaxMs);
      res.statusCode = decision.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(decision));
      return;
    }
    if (url === '/metrics' || url.startsWith('/metrics?')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      res.end(renderMetricsText(health));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return await new Promise<SubstrateHealthServer | undefined>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      console.warn(
        `[kagent-operator] substrate health server bind failed (port=${port.toString()}): ${err.message} — /healthz + /metrics disabled`,
      );
      resolve(undefined);
    });
    server.listen(port, () => {
      console.log(
        `[kagent-operator] substrate health server listening on :${port.toString()} (/healthz, /metrics)`,
      );
      resolve({
        port,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          }),
      });
    });
  });
}
