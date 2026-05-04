/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AuditPublisher` — NATS JetStream publish surface for the audit
 * stream.
 *
 * Constraints (per docs/SUBSTRATE-V1.md §4.3 + Wave 0 brief):
 *
 *   - **Best-effort.** Audit emission is OBSERVABILITY, not in the
 *     request critical path. A NATS outage MUST NOT crash the
 *     operator's reconcile loop or the agent-pod's task execution.
 *     `publish()` therefore catches every failure path and logs a
 *     warning; it never throws. (Compare with NatsDispatcher which
 *     IS in the dispatch critical path and propagates publish
 *     errors so the reconciler can retry.)
 *   - **Lazy connect.** The constructor doesn't open the NATS socket;
 *     `connect()` does. Callers that boot before the audit stream
 *     exists (e.g. operator boot under Helm install ordering) can
 *     still construct the publisher; `publish()` no-ops with a
 *     warning until the connection succeeds.
 *   - **Subject convention.** All audit events publish to
 *     `audit.<eventType>` (eg `audit.task.admitted`, `audit.capability.minted`).
 *     The JetStream `audit` stream binds to `audit.>`.
 *
 * Production wiring (see operator/main.ts):
 *
 *     const publisher = new AuditPublisher({ source: 'kagent.knuteson.io/operator' });
 *     await publisher.connect(process.env.KAGENT_NATS_URL);
 *     ...
 *     await publisher.publish(auditEvent);
 *
 * Test wiring: pass a stubbed `connectFn` so unit tests can verify
 * graceful no-op + happy-path emission without standing up NATS.
 */

import type { AuditEvent } from './types.js';

/**
 * Subset of `nats.js`'s `NatsConnection` we use. Kept narrow so tests
 * can pass a stub without dragging in the whole NATS type surface
 * (mirrors NatsDispatcher's NatsConnectionLike).
 */
export interface AuditNatsConnectionLike {
  publish(subject: string, data: Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Factory for opening a NATS connection. Production wires this to
 * `connect({ servers })` from `nats`; tests inject a stub that returns
 * a pre-built fake connection (or rejects, to exercise the graceful
 * no-op path).
 */
export type AuditConnectFn = (url: string) => Promise<AuditNatsConnectionLike>;

/**
 * Logging surface — kept tiny so the publisher doesn't pull pino /
 * winston into the audit-events package. Operator + agent-pod both
 * use `console.warn` / `console.error`; the publisher matches.
 */
export interface AuditLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const consoleLogger: AuditLogger = {
  warn: (message, ...args) => {
    console.warn(message, ...args);
  },
  error: (message, ...args) => {
    console.error(message, ...args);
  },
};

export interface AuditPublisherOptions {
  /**
   * CE `source` value for emissions from this publisher. Set once at
   * construction so callsites only pass the type-specific data.
   * Convention: `kagent.knuteson.io/<component>`.
   */
  readonly source?: string;
  /**
   * Subject prefix for all publishes — defaults to `audit`. The full
   * subject is `${prefix}.${event.type}`. Override only if you're
   * provisioning a separate stream (e.g. testing).
   */
  readonly subjectPrefix?: string;
  /**
   * Connection factory. Production wires this to `connect({ servers })`
   * from `nats`; tests inject a stub. Defaults to a lazy-resolve of
   * the `nats` package so consumers that don't `connect()` (e.g.
   * pure unit tests on the operator) don't pay for a NATS import.
   */
  readonly connectFn?: AuditConnectFn;
  /**
   * Logger override — defaults to console. Tests inject a spy so they
   * can assert "publish on disconnected publisher logs warning".
   */
  readonly logger?: AuditLogger;
}

const DEFAULT_PREFIX = 'audit';

/**
 * Default lazy connect factory. Imports `nats` only when called so
 * test consumers that never invoke `connect()` don't pay the import
 * cost.
 */
const defaultConnectFn: AuditConnectFn = async (url) => {
  // Dynamic import — keeps `nats` out of the cold-start path of any
  // consumer that doesn't actually emit audit events on its boot path.
  // The operator/agent-pod will both call connect() at startup so this
  // resolves once per process.
  const nats = await import('nats');
  return await nats.connect({ servers: url });
};

const encoder = new TextEncoder();

/**
 * Audit publisher. Construct once per process; `connect()` opens the
 * NATS connection lazily; `publish()` emits one event onto the audit
 * stream.
 *
 * Lifecycle:
 *
 *   1. `new AuditPublisher({ source: 'kagent.knuteson.io/operator' })`
 *   2. `await publisher.connect(NATS_URL)`
 *      — on failure, the publisher stays "disconnected"; subsequent
 *        publish() calls warn-and-no-op until a re-connect succeeds.
 *   3. `await publisher.publish(event)` per emission.
 *      — flush() is awaited so callers can chain status writes; in
 *        the disconnected/unreachable case publish() returns
 *        immediately without throwing.
 *   4. `await publisher.close()` on graceful shutdown.
 */
export class AuditPublisher {
  private readonly source: string | undefined;
  private readonly subjectPrefix: string;
  private readonly connectFn: AuditConnectFn;
  private readonly logger: AuditLogger;
  private connection: AuditNatsConnectionLike | undefined;
  private connected = false;

  constructor(options: AuditPublisherOptions = {}) {
    this.source = options.source;
    this.subjectPrefix = options.subjectPrefix ?? DEFAULT_PREFIX;
    this.connectFn = options.connectFn ?? defaultConnectFn;
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * Attempt to open the NATS connection. On failure, log a warning and
   * return: the publisher stays disconnected (subsequent `publish()`
   * calls no-op with warnings), but boot is NOT blocked. This is the
   * "audit is best-effort" contract.
   *
   * Idempotent: a second `connect()` against an already-connected
   * publisher is a no-op.
   */
  async connect(url: string): Promise<void> {
    if (this.connected) return;
    if (typeof url !== 'string' || url.length === 0) {
      this.logger.warn(
        '[kagent-audit] connect() called with empty NATS URL — audit publisher disabled (events will no-op)',
      );
      return;
    }
    try {
      this.connection = await this.connectFn(url);
      this.connected = true;
    } catch (err) {
      // Audit is observability, not critical-path. Log the failure
      // and let the caller continue. Subsequent publish() calls will
      // detect the disconnected state and warn-and-no-op individually
      // (so we don't lose every event in a buffer if the connection
      // later recovers).
      this.logger.warn(
        '[kagent-audit] failed to connect NATS — audit events will no-op until reconnect:',
        err,
      );
      this.connected = false;
      this.connection = undefined;
    }
  }

  /**
   * Publish a single CloudEvents-shaped audit event. Best-effort:
   *
   *   - When disconnected (never connected, or connect() failed) →
   *     warn and return.
   *   - When publish() throws (connection dropped between connect and
   *     publish) → warn and return; the connection is marked
   *     disconnected so a subsequent connect() is required to recover.
   *
   * Subject is `${subjectPrefix}.${event.type}`. Stream binding
   * (`audit.>`) is provisioned by the Helm chart's audit-stream Job.
   */
  async publish(event: AuditEvent): Promise<void> {
    if (!this.connected || this.connection === undefined) {
      this.logger.warn(
        `[kagent-audit] publish(${event.type}) on disconnected publisher — event dropped (best-effort)`,
      );
      return;
    }
    const subject = `${this.subjectPrefix}.${event.type}`;
    let payload: Uint8Array;
    try {
      payload = encoder.encode(JSON.stringify(event));
    } catch (err) {
      this.logger.error(`[kagent-audit] failed to serialize ${event.type} event:`, err);
      return;
    }
    try {
      this.connection.publish(subject, payload);
      // flush() resolves once the publish has been written to the
      // socket. Awaiting keeps the caller's "did we publish?" promise
      // honest — but a flush failure must NOT throw out of publish()
      // (audit best-effort contract). Catch + warn-and-continue.
      await this.connection.flush();
    } catch (err) {
      this.logger.warn(
        `[kagent-audit] failed to publish ${event.type} (event dropped, audit is best-effort):`,
        err,
      );
      // Mark disconnected so subsequent publishes warn quickly without
      // re-attempting against a dead connection. Caller can re-invoke
      // connect() to recover.
      this.connected = false;
    }
  }

  /**
   * Close the underlying NATS connection (if any). Idempotent. Safe to
   * call multiple times (e.g. SIGTERM + SIGINT handlers both fire).
   */
  async close(): Promise<void> {
    if (this.connection !== undefined) {
      try {
        await this.connection.close();
      } catch (err) {
        // Already-closed connections sometimes throw on close —
        // immaterial for graceful shutdown, log + swallow.
        this.logger.warn('[kagent-audit] connection close raised:', err);
      }
      this.connection = undefined;
      this.connected = false;
    }
  }

  /** Test-helper: returns true once `connect()` has succeeded. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Returns the configured CE `source` (or undefined if none set). */
  getSource(): string | undefined {
    return this.source;
  }
}
