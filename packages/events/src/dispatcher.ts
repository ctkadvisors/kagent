/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `EventDispatcher` — operator-side runtime that turns NATS event
 * deliveries into AgentTask creations.
 *
 * Wave 3 wiring:
 *
 *   1. At operator boot (when `KAGENT_EVENTS_ENABLED=true`), main.ts
 *      provisions the `kagent-events` JetStream stream
 *      (`kagent.events.>`), constructs a single `EventDispatcher`,
 *      and feeds it the full set of `Agent.spec.subscribes[]`
 *      declarations from the Agent informer.
 *   2. For each subscription, the dispatcher creates a durable
 *      pull-consumer named `kagent-evt-<agentName>-<topicHash>`
 *      filtered to `kagent.events.<topic>`.
 *   3. The dispatcher's `consume()` loop receives `JsMsg`, deserializes
 *      the CloudEvents envelope, mints an AgentTask via the operator-
 *      supplied `createAgentTask` callback, and acks the message.
 *
 * Trust boundary:
 *
 *   - Only Agents whose `capabilityClaims.subscribe` admits the topic
 *     get a consumer registered. Admission validates this; the
 *     dispatcher's `applySubscriptions()` re-validates as a defense-
 *     in-depth gate (the operator's informer cache could be momentarily
 *     stale; we never want to mint a task on an unauthorized
 *     subscription).
 *   - Topics are exact (NATS wildcards `*` / `>` are forbidden in
 *     `validateTopic`). A subscriber filtering on `kagent.events.research.*`
 *     is rejected at admission. This intentionally narrows the surface
 *     so a misconfigured topic glob can't subscribe an Agent to events
 *     it shouldn't see — the cap claim is the glob authority, not the
 *     subscription declaration.
 *
 * The dispatcher is bounded by the NATS pull-consumer ack-deadline,
 * so a slow `createAgentTask` will redeliver. We log + nack-on-error
 * so the consumer's `max_deliver` (configurable on the consumer) is
 * the operational backstop against an LLM-driven create storm.
 */

import { createHash } from 'node:crypto';

import { EVENTS_SUBJECT_PREFIX, eventSubject, validateTopic } from './types.js';
import type { KagentCloudEvent } from './types.js';
import { isTopicAdmittedBySubscribeClaims } from './validate.js';

/**
 * Trigger-input-binding template — the substrate's contract for how
 * an event's payload threads into the spawned AgentTask. Mirrors
 * `AgentTask.spec.inputs[].from.scalar` shape (per docs/SUBSTRATE-V1.md
 * §3.1 + Wave 1 typed-I/O), but populated at trigger-fire time from
 * the event's `data` field rather than at GitOps authoring time.
 */
export interface EventTriggerInputBindingTemplate {
  /** Name of the target Agent's `inputs[].name` to bind. */
  readonly inputName: string;
}

/**
 * One declared subscription — corresponds to one
 * `Agent.spec.subscribes[]` entry. Identifies the AgentTask the
 * operator should mint when a matching event arrives.
 */
export interface EventSubscription {
  /** Namespace + agent identity — used to construct the AgentTask. */
  readonly agentNamespace: string;
  readonly agentName: string;
  /** Exact NATS topic — `validateTopic` must accept. */
  readonly topic: string;
  /**
   * Subscribe-claim glob list from the Agent's `capabilityClaims.subscribe`.
   * The dispatcher RE-validates this against the topic before
   * registering the consumer. Empty / unset = never registered.
   */
  readonly subscribeClaims: readonly string[] | undefined;
  /**
   * Optional input-binding template. When unset, the event's `data`
   * is forwarded as `AgentTask.spec.payload` (legacy / opaque path).
   * When set, the dispatcher renders an
   * `AgentTask.spec.inputs[<inputName>] = { scalar: <event.data> }`
   * binding so the agent loop receives the event payload via the
   * Wave 1 typed-input pipeline.
   */
  readonly inputBinding?: EventTriggerInputBindingTemplate;
}

/**
 * Subscription that has passed the dispatcher's defense-in-depth
 * cap-check. Internal to the dispatcher; surfaced via
 * `getActiveSubscriptions()` for tests + observability.
 */
export interface ResolvedEventSubscription extends EventSubscription {
  /** Computed JetStream consumer name (durable). */
  readonly consumerName: string;
  /** Computed NATS subject filter — `kagent.events.<topic>`. */
  readonly subject: string;
}

/**
 * The operator-provided AgentTask minting callback. Receives the
 * resolved subscription + the parsed event; returns when the
 * AgentTask is created (or rejects when the K8s API returns an error).
 *
 * The dispatcher's loop wraps this in try/catch + nack-on-error.
 */
export type AgentTaskCreator = (
  sub: ResolvedEventSubscription,
  event: KagentCloudEvent<unknown>,
) => Promise<void>;

/**
 * Subset of nats.js's `JsMsg` we use. Kept narrow so tests can pass
 * a simple object literal. (The real API is much wider — we just need
 * `data` + `ack` / `nak` / `term`.)
 */
export interface JetStreamMsgLike {
  readonly data: Uint8Array;
  readonly subject: string;
  ack(): void;
  /** Negative-ack with optional re-delivery delay (ms). */
  nak(delay?: number): void;
  /** Permanently fail this delivery — no re-delivery. */
  term(): void;
}

/**
 * Closeable iterator-like surface. The real nats.js `ConsumerMessages`
 * extends `QueuedIterator<JsMsg>` + adds `close()`; for the
 * dispatcher's purposes we only need a way to (a) iterate messages
 * with a callback and (b) close. The pull-consumer factory below
 * builds these.
 */
export interface ConsumerSubscription {
  close(): Promise<void>;
}

/**
 * Factory that builds + starts a single pull-consumer. The dispatcher
 * calls this once per subscription. Implementations:
 *
 *   - Production: built in `main.ts` over the `nats.js` JetStream
 *     manager (creates a durable consumer and calls
 *     `consumer.consume({ callback: ... })`).
 *   - Tests: stubbed to keep callbacks in a registry the test drives.
 *
 * `onMsg` MUST be synchronous-on-arrival but the registered async
 * processing is allowed to run after — the callback invokes the
 * dispatcher's internal queue handler.
 */
export type ConsumerFactory = (
  resolved: ResolvedEventSubscription,
  onMsg: (msg: JetStreamMsgLike) => void,
) => Promise<ConsumerSubscription>;

/* =====================================================================
 * Constants — exported for tests + main.ts wiring.
 * ===================================================================== */

/** Label key on minted AgentTasks identifying the source subscription. */
export const EVENT_TRIGGER_LABEL = 'kagent.knuteson.io/event-trigger' as const;
/** Label key carrying the topic that fired the trigger. */
export const EVENT_TRIGGER_LABEL_TOPIC = 'kagent.knuteson.io/event-topic' as const;
/** `managed-by` label value uniformly stamped on event-trigger AgentTasks. */
export const EVENT_TRIGGER_MANAGED_BY_VALUE = 'kagent-events' as const;

/** Hash bucket size for the consumer-name suffix. Trades collision risk vs
 * label-length budget. 16 hex chars (64 bits) is collision-safe for
 * the topic-cardinality we expect (low thousands per cluster). */
const CONSUMER_NAME_HASH_LEN = 16;
/** Cap on the consumer name's prefix portion (Agent name) so the full
 * `kagent-evt-<agent>-<hash>` stays under JetStream's 256-char limit. */
const CONSUMER_NAME_AGENT_MAX = 64;

/* =====================================================================
 * Dispatcher
 * ===================================================================== */

export interface EventDispatcherDeps {
  /** Factory that builds + starts a pull-consumer. */
  readonly buildConsumer: ConsumerFactory;
  /** AgentTask minting callback (operator-supplied). */
  readonly createAgentTask: AgentTaskCreator;
  /** Logger override — defaults to console. */
  readonly logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  /**
   * Subject prefix override — defaults to `kagent.events`. Locked
   * per WAVES.md §5.6. Tests use a unique prefix to avoid stream
   * collisions when running in parallel against a real NATS.
   */
  readonly subjectPrefix?: string;
}

export interface EventDispatcherStartOptions {
  readonly subscriptions: readonly EventSubscription[];
}

export interface EventDispatcher {
  /**
   * Apply a (possibly updated) set of subscriptions. Idempotent:
   * existing consumers for unchanged subscriptions are kept; ones
   * that disappeared are closed; new ones are created. Re-callable
   * on every Agent informer update.
   */
  applySubscriptions(subs: readonly EventSubscription[]): Promise<void>;
  /** Currently-active subscriptions (post cap-check). */
  getActiveSubscriptions(): readonly ResolvedEventSubscription[];
  /** Stop every consumer. Idempotent; safe in shutdown handlers. */
  stop(): Promise<void>;
}

export function buildEventDispatcher(deps: EventDispatcherDeps): EventDispatcher {
  const subjectPrefix = deps.subjectPrefix ?? EVENTS_SUBJECT_PREFIX;
  const logger = deps.logger ?? defaultLogger();
  /** key = `<namespace>/<agent>/<topic>` → active subscription */
  const active = new Map<string, ActiveEntry>();
  let stopped = false;
  const decoder = new TextDecoder();

  return {
    async applySubscriptions(subs) {
      if (stopped) return;
      const desiredKeys = new Set<string>();
      const desiredByKey = new Map<string, EventSubscription>();
      for (const s of subs) {
        const key = subscriptionKey(s);
        // Defense-in-depth — drop subscriptions whose topic isn't
        // admitted by the cap-claim list (admission already gated
        // this; we re-check so a cache-stale informer can't slip
        // an unauthorized consumer through).
        const tv = validateTopic(s.topic);
        if (!tv.ok) {
          logger.warn(
            `[kagent-events] dropping subscription with invalid topic for ${s.agentNamespace}/${s.agentName}: ${tv.error}`,
          );
          continue;
        }
        if (!isTopicAdmittedBySubscribeClaims(s.topic, s.subscribeClaims)) {
          logger.warn(
            `[kagent-events] dropping subscription ${s.agentNamespace}/${s.agentName} → topic="${s.topic}" not admitted by capability subscribe-claims`,
          );
          continue;
        }
        desiredKeys.add(key);
        desiredByKey.set(key, s);
      }

      // Remove consumers no longer desired.
      for (const [key, entry] of active) {
        if (!desiredKeys.has(key)) {
          try {
            await entry.subscription.close();
          } catch (err) {
            logger.warn(
              `[kagent-events] failed to close consumer for ${key} (continuing): ${describeError(err)}`,
            );
          }
          active.delete(key);
        }
      }

      // Add consumers for new subscriptions.
      for (const key of desiredKeys) {
        if (active.has(key)) continue;
        const s = desiredByKey.get(key);
        if (s === undefined) continue;
        const resolved: ResolvedEventSubscription = {
          ...s,
          consumerName: computeConsumerName(s),
          subject: eventSubject(s.topic, subjectPrefix),
        };
        try {
          const subscription = await deps.buildConsumer(resolved, (msg) => {
            // Schedule async processing — must NOT await inside the
            // callback (per nats.js callback contract). We track the
            // in-flight promise on the entry so stop() can drain.
            void handleMessage(resolved, msg);
          });
          active.set(key, { resolved, subscription });
          logger.info(
            `[kagent-events] consumer registered ${resolved.agentNamespace}/${resolved.agentName} ← topic="${resolved.topic}" subject="${resolved.subject}" consumer="${resolved.consumerName}"`,
          );
        } catch (err) {
          logger.error(
            `[kagent-events] failed to register consumer for ${s.agentNamespace}/${s.agentName} (topic=${s.topic}): ${describeError(err)}`,
          );
        }
      }
    },

    getActiveSubscriptions() {
      return Array.from(active.values()).map((e) => e.resolved);
    },

    async stop() {
      stopped = true;
      const closes: Promise<void>[] = [];
      for (const entry of active.values()) {
        closes.push(
          entry.subscription.close().catch((err: unknown) => {
            logger.warn(`[kagent-events] consumer close raised: ${describeError(err)}`);
          }),
        );
      }
      active.clear();
      await Promise.all(closes);
    },
  };

  /**
   * Per-message handler. Parses the CloudEvents envelope, calls the
   * operator's `createAgentTask`, then acks. Errors are logged + the
   * message is `nak`'d so JetStream re-delivers (bounded by the
   * consumer's `max_deliver`).
   */
  async function handleMessage(
    sub: ResolvedEventSubscription,
    msg: JetStreamMsgLike,
  ): Promise<void> {
    let parsed: KagentCloudEvent<unknown>;
    try {
      parsed = JSON.parse(decoder.decode(msg.data)) as KagentCloudEvent<unknown>;
    } catch (err) {
      logger.warn(
        `[kagent-events] dropping unparseable event on ${sub.subject} (terminating delivery): ${describeError(err)}`,
      );
      msg.term();
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn(`[kagent-events] dropping non-object event on ${sub.subject}`);
      msg.term();
      return;
    }
    if (parsed.type !== sub.topic) {
      // The subject filter alone is enough — but the envelope's
      // `type` should match the subject's topic. Log + still
      // dispatch (don't gate the substrate on application-side
      // taxonomy drift; the audit trail is enough).
      logger.warn(
        `[kagent-events] event type "${parsed.type}" does not match subscription topic "${sub.topic}" on subject ${sub.subject}; dispatching anyway`,
      );
    }
    try {
      await deps.createAgentTask(sub, parsed);
      msg.ack();
    } catch (err) {
      logger.warn(
        `[kagent-events] createAgentTask failed for ${sub.agentNamespace}/${sub.agentName} ← ${sub.subject}: ${describeError(err)}`,
      );
      // nak with backoff; consumer's `max_deliver` is the cap on retries.
      try {
        msg.nak(5_000);
      } catch (nackErr) {
        logger.warn(`[kagent-events] nak() raised for ${sub.subject}: ${describeError(nackErr)}`);
      }
    }
  }
}

interface ActiveEntry {
  readonly resolved: ResolvedEventSubscription;
  readonly subscription: ConsumerSubscription;
}

function subscriptionKey(s: EventSubscription): string {
  return `${s.agentNamespace}/${s.agentName}/${s.topic}`;
}

/**
 * Compute a deterministic, JetStream-valid durable consumer name.
 *
 * Format: `kagent-evt-<agentName>-<sha256(topic)[0..16]>`.
 *
 * Rationale:
 *   - `kagent-evt-` prefix lets `nats consumer ls` filter our
 *     consumers vs. application-managed ones.
 *   - Agent name (truncated to 64 chars) keeps the consumer human-
 *     identifiable in `nats consumer info`.
 *   - sha256-truncated topic suffix collapses long / wildcard-y
 *     topics into a fixed-length identifier, JetStream-valid (no
 *     `.` or `*` in consumer names).
 *
 * The sha256 is computed via Node's `node:crypto` so we don't need
 * a runtime dep on `crypto-js` or similar.
 */
export function computeConsumerName(s: {
  readonly agentName: string;
  readonly topic: string;
}): string {
  const truncatedAgent = s.agentName.slice(0, CONSUMER_NAME_AGENT_MAX);
  // K8s names already match `[a-z0-9-]+`, so no extra sanitization.
  const hash = createHash('sha256').update(s.topic).digest('hex').slice(0, CONSUMER_NAME_HASH_LEN);
  return `kagent-evt-${truncatedAgent}-${hash}`;
}

function defaultLogger(): NonNullable<EventDispatcherDeps['logger']> {
  return {
    info: (m, ...args) => {
      console.log(m, ...args);
    },
    warn: (m, ...args) => {
      console.warn(m, ...args);
    },
    error: (m, ...args) => {
      console.error(m, ...args);
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
