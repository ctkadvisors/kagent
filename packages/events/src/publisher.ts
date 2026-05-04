/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `EventPublisher` — NATS JetStream publish surface for Wave 3 events.
 *
 * Mirrors `@kagent/audit-events`'s `AuditPublisher` shape so the two
 * stay one-to-one in operational + test wiring. Differences:
 *
 *   - Subject is `kagent.events.<topic>` (vs. `audit.<eventType>`).
 *   - Publish is INPUT-VALIDATED before the wire — every emission
 *     runs through `validateTopic` AND (when a `publishClaims` glob
 *     list is supplied) `isTopicAdmittedByPublishClaims`. Refusal
 *     throws (NOT best-effort) — the agent-pod's `publish_event`
 *     tool surfaces the structured error to the LLM instead of
 *     silently dropping. Compare with audit's "warn-and-no-op" path
 *     which is correct for observability emission and wrong for
 *     application-emitted events.
 *   - Optional payload validator: when a registry has a validator
 *     for the topic, publish refuses on validator failure.
 *   - Lazy connect (same pattern as AuditPublisher): construction
 *     never opens NATS; `connect()` does. A NATS outage degrades
 *     publish to "warn + return" so the agent-pod's tool returns a
 *     structured error to the LLM instead of crashing the run.
 */

import { buildCloudEvent } from './make-event.js';
import {
  EVENTS_SUBJECT_PREFIX,
  eventSubject,
  validateTopic,
  type KagentCloudEvent,
} from './types.js';
import { isTopicAdmittedByPublishClaims, type EventValidatorRegistry } from './validate.js';

/**
 * Subset of `nats.js`'s `NatsConnection` we use. Kept narrow so tests
 * can pass a stub without dragging in the whole NATS type surface
 * (mirrors the AuditPublisher's NatsConnectionLike).
 */
export interface EventNatsConnectionLike {
  publish(subject: string, data: Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type EventConnectFn = (url: string) => Promise<EventNatsConnectionLike>;

export interface EventLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const consoleLogger: EventLogger = {
  warn: (message, ...args) => {
    console.warn(message, ...args);
  },
  error: (message, ...args) => {
    console.error(message, ...args);
  },
};

export interface EventPublisherOptions {
  /**
   * CE `source` URI for emissions from this publisher. Convention for
   * agent-pod emissions: `kagent.knuteson.io/agent-pod/<agent>/<taskUid>`.
   * Caller assembles + passes once at construction; `publish()`
   * builders use it as the default.
   */
  readonly source: string;
  /**
   * Subject prefix — defaults to `kagent.events`. Override only in
   * tests or when collocating with another consumer that already
   * owns the prefix. Locked to `kagent.events` per WAVES.md §5.6
   * (Blackboard owns `kagent.kv.*`, Audit owns `audit.*`).
   */
  readonly subjectPrefix?: string;
  /**
   * Publish-claim glob list (the publisher's `cap.claims.publish`
   * patterns). When set, every `publish()` call cross-checks the
   * topic against this list and refuses on mismatch. Optional so
   * smoke-test rigs can publish without a cap bundle.
   */
  readonly publishClaims?: readonly string[];
  /**
   * Optional payload validator registry. When the topic has a
   * registered validator, publish refuses on validator failure.
   * Absent / no entry = unvalidated.
   */
  readonly validators?: EventValidatorRegistry;
  /** Lazy NATS connect factory — defaults to dynamic import of `nats`. */
  readonly connectFn?: EventConnectFn;
  /** Logger override — defaults to console. */
  readonly logger?: EventLogger;
}

const defaultConnectFn: EventConnectFn = async (url) => {
  const nats = await import('nats');
  return await nats.connect({ servers: url });
};

const encoder = new TextEncoder();

export interface PublishInput<T = unknown> {
  readonly topic: string;
  readonly data: T;
  /**
   * Optional CloudEvents `subject` — the resource the event is about
   * (`AgentTask/<ns>/<name>`, `Workspace/<ns>/<name>`, ...). Omitted
   * when undefined — the emitted envelope does not carry an empty
   * `subject` field.
   */
  readonly subject?: string;
  /**
   * Optional source override. Defaults to the publisher's
   * constructor `source` value. Useful when a single publisher
   * instance fronts multiple emission sites (rare).
   */
  readonly source?: string;
}

/**
 * Wave 3 events publisher. Construct once per process; `connect()`
 * opens the NATS connection lazily; `publish()` validates +
 * serializes + emits to `kagent.events.<topic>`.
 *
 * Failure modes (in order of severity):
 *
 *   - Invalid topic / cap denial / payload validator failure →
 *     `publish()` THROWS. The caller (`publish_event` tool) returns
 *     the structured `policy_denied:` / `validation_failed:` error
 *     to the LLM.
 *   - NATS unreachable / not connected → `publish()` returns false
 *     and warns. The caller can choose to retry or surface "best-
 *     effort dropped" — the agent-pod tool returns a structured
 *     `infra_unavailable:` error so the LLM doesn't re-loop on the
 *     same publish.
 *
 * The split (throw vs return-false) lines up with the substrate's
 * "loud failures, structured causes" rule — application-layer
 * authority violations (cap denial) MUST surface; substrate-layer
 * outages (NATS down) are best-effort.
 */
export class EventPublisher {
  private readonly source: string;
  private readonly subjectPrefix: string;
  private readonly publishClaims: readonly string[] | undefined;
  private readonly validators: EventValidatorRegistry | undefined;
  private readonly connectFn: EventConnectFn;
  private readonly logger: EventLogger;
  private connection: EventNatsConnectionLike | undefined;
  private connected = false;

  constructor(options: EventPublisherOptions) {
    if (typeof options.source !== 'string' || options.source.length === 0) {
      throw new Error('EventPublisher: options.source must be a non-empty string');
    }
    this.source = options.source;
    this.subjectPrefix = options.subjectPrefix ?? EVENTS_SUBJECT_PREFIX;
    this.publishClaims = options.publishClaims;
    this.validators = options.validators;
    this.connectFn = options.connectFn ?? defaultConnectFn;
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * Open the NATS connection. Idempotent. On failure, log + leave the
   * publisher disconnected; subsequent `publish()` calls warn + return
   * false.
   */
  async connect(url: string): Promise<void> {
    if (this.connected) return;
    if (typeof url !== 'string' || url.length === 0) {
      this.logger.warn('[kagent-events] connect() called with empty NATS URL — publisher disabled');
      return;
    }
    try {
      this.connection = await this.connectFn(url);
      this.connected = true;
    } catch (err) {
      this.logger.warn(
        '[kagent-events] failed to connect NATS — publishes will return false until reconnect:',
        err,
      );
      this.connected = false;
      this.connection = undefined;
    }
  }

  /**
   * Validate + serialize + publish a Wave 3 event. Returns the
   * envelope that was emitted (so the caller's tool result can echo
   * the `id` for downstream tracing). Throws on cap / topic /
   * payload validation failure; returns `{ ok: false }` on NATS
   * unavailability.
   */
  async publish<T>(
    input: PublishInput<T>,
  ): Promise<
    | { readonly ok: true; readonly event: KagentCloudEvent<T>; readonly subject: string }
    | {
        readonly ok: false;
        readonly reason: 'disconnected' | 'flush_failed';
        readonly error?: unknown;
      }
  > {
    // ---- input validation (THROW on application-authority failures) -
    const topicValidation = validateTopic(input.topic);
    if (!topicValidation.ok) {
      throw new Error(`publish: invalid topic — ${topicValidation.error}`);
    }
    if (this.publishClaims !== undefined) {
      if (!isTopicAdmittedByPublishClaims(input.topic, this.publishClaims)) {
        throw new Error(
          `publish: topic "${input.topic}" not admitted by capability publish-claims [${this.publishClaims.join(', ')}]`,
        );
      }
    }
    if (this.validators !== undefined) {
      const validation = this.validators.validate(input.topic, input.data);
      if (!validation.ok) {
        throw new Error(
          `publish: payload for topic "${input.topic}" failed validator: ${validation.error}`,
        );
      }
    }

    // ---- envelope assembly ----------------------------------------
    const event = buildCloudEvent<T>({
      type: input.topic,
      source: input.source ?? this.source,
      ...(input.subject !== undefined && { subject: input.subject }),
      data: input.data,
    });

    // ---- emission (best-effort on infra) ---------------------------
    if (!this.connected || this.connection === undefined) {
      this.logger.warn(
        `[kagent-events] publish(${input.topic}) on disconnected publisher — event dropped`,
      );
      return { ok: false, reason: 'disconnected' };
    }
    const subject = eventSubject(input.topic, this.subjectPrefix);
    let payload: Uint8Array;
    try {
      payload = encoder.encode(JSON.stringify(event));
    } catch (err) {
      this.logger.error(`[kagent-events] failed to serialize event for ${input.topic}:`, err);
      throw new Error(`publish: failed to serialize event payload (${describeError(err)})`);
    }
    try {
      this.connection.publish(subject, payload);
      await this.connection.flush();
    } catch (err) {
      this.logger.warn(`[kagent-events] failed to publish ${input.topic} (event dropped):`, err);
      // Mark disconnected so subsequent publishes warn quickly.
      this.connected = false;
      return { ok: false, reason: 'flush_failed', error: err };
    }
    return { ok: true, event, subject };
  }

  /** Close the underlying NATS connection. Idempotent. */
  async close(): Promise<void> {
    if (this.connection !== undefined) {
      try {
        await this.connection.close();
      } catch (err) {
        this.logger.warn('[kagent-events] connection close raised:', err);
      }
      this.connection = undefined;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSource(): string {
    return this.source;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
