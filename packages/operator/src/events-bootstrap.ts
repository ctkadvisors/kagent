/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 Events sub-team — operator-side bootstrap for the
 * `kagent-events` JetStream stream + per-subscription pull-consumer
 * factory + AgentTask-creator glue.
 *
 * Surfaces:
 *
 *   - `provisionEventsStream` — idempotent stream-creator. Called
 *     once at operator boot (when `KAGENT_EVENTS_ENABLED=true`).
 *     Mirrors the audit-stream Helm hook's "create or update" shape
 *     so the operator stays self-contained on a fresh install while
 *     a Helm-side hook job ALSO ensures the stream exists for
 *     pre-boot consumers.
 *   - `buildNatsPullConsumerFactory` — implements `ConsumerFactory`
 *     over `nats.js`'s `JetStreamManager.consumers.add` +
 *     `consumer.consume({ callback })`. The factory is wired into
 *     `EventDispatcher` at boot.
 *   - `buildEventTriggerAgentTaskCreator` — turns a delivered event
 *     into a `kubectl apply`-style AgentTask manifest and POSTs it
 *     to the K8s API. The minted AgentTask is labeled +
 *     annotation-tagged so observability can correlate the
 *     event-triggered run back to its origin.
 */

import { type CustomObjectsApi } from '@kubernetes/client-node';

import {
  EVENT_TRIGGER_LABEL,
  EVENT_TRIGGER_LABEL_TOPIC,
  EVENT_TRIGGER_MANAGED_BY_VALUE,
  type AgentTaskCreator,
  type ConsumerFactory,
  type JetStreamMsgLike,
  type KagentCloudEvent,
  type ResolvedEventSubscription,
} from '@kagent/events';

import { API_GROUP, API_VERSION } from './crds/index.js';

/** Plural the operator uses for AgentTask CRDs. Mirrors triggers-bootstrap. */
const AGENT_TASK_PLURAL = 'agenttasks';

/* =====================================================================
 * Stream provisioning — idempotent JetStream stream upsert.
 * ===================================================================== */

export interface EventsStreamConfig {
  /** Stream name. Default `kagent-events`. */
  readonly name: string;
  /** Subject filter — defaults to `kagent.events.>`. */
  readonly subjects: readonly string[];
  /** Max retention (nanoseconds, per JetStream API). */
  readonly maxAgeNs: number;
  /** Replicas. Default 1 (single-node K3s baseline). */
  readonly replicas: number;
}

/** Subset of nats.js's `StreamAPI` we use — narrowed for testability. */
export interface StreamApiLike {
  info(name: string): Promise<unknown>;
  add(config: Record<string, unknown>): Promise<unknown>;
  update(name: string, config: Record<string, unknown>): Promise<unknown>;
}

/** Subset of nats.js's `JetStreamManager` we use. */
export interface JetStreamManagerLike {
  readonly streams: StreamApiLike;
}

export interface ProvisionEventsStreamOptions {
  readonly jsm: JetStreamManagerLike;
  readonly config: EventsStreamConfig;
  readonly logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
  };
}

/**
 * Idempotent provision: try `info(name)`; on success, `update`; on
 * failure (stream not found), `add`. Either path lands the requested
 * config — same shape as the audit-stream Helm hook.
 *
 * Fails-soft on JetStream errors (logs + returns); the operator's
 * `EventDispatcher` will still try to register consumers and surface
 * `consumer_not_found` errors if the stream isn't actually there.
 * Best-effort matches the AuditPublisher pattern.
 */
export async function provisionEventsStream(
  opts: ProvisionEventsStreamOptions,
): Promise<{ readonly created: boolean } | { readonly skipped: true; readonly error: string }> {
  const { jsm, config, logger } = opts;
  const log = logger ?? {
    info: (m: string) => {
      console.log(m);
    },
    warn: (m: string) => {
      console.warn(m);
    },
  };
  const desired: Record<string, unknown> = {
    name: config.name,
    subjects: [...config.subjects],
    retention: 'limits',
    storage: 'file',
    discard: 'old',
    max_age: config.maxAgeNs,
    num_replicas: config.replicas,
  };
  try {
    await jsm.streams.info(config.name);
    await jsm.streams.update(config.name, desired);
    log.info(`[kagent-events] stream "${config.name}" reconciled`);
    return { created: false };
  } catch {
    try {
      await jsm.streams.add(desired);
      log.info(`[kagent-events] stream "${config.name}" created`);
      return { created: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[kagent-events] stream provision skipped (best-effort): ${msg}`);
      return { skipped: true, error: msg };
    }
  }
}

/* =====================================================================
 * Pull-consumer factory — turns a `ResolvedEventSubscription` into a
 * live nats.js consumer with a callback.
 * ===================================================================== */

/** Subset of nats.js's `Consumer` we use. */
export interface ConsumerLike {
  consume(opts: {
    callback?: (msg: JetStreamMsgLike) => void;
  }): Promise<{ close(): Promise<void | Error> }>;
}

/** Subset of nats.js's `Consumers` index. */
export interface ConsumersLike {
  get(stream: string, name: string): Promise<ConsumerLike>;
}

/** Subset of nats.js's `JetStreamClient` we use. */
export interface JetStreamClientLike {
  readonly consumers: ConsumersLike;
}

/**
 * Build a `ConsumerFactory` (per `@kagent/events:dispatcher.ts`) over
 * a real nats.js JetStream client + manager. Each subscription gets
 * a durable pull-consumer added (idempotent — JetStream's add returns
 * the existing consumer's info if a matching name is present).
 */
export interface NatsPullConsumerFactoryDeps {
  readonly jsm: JetStreamManagerLike & {
    /**
     * Method used to add or update a consumer. Mirrors nats.js's
     * `JetStreamManager.consumers.add(stream, opts)`. Kept as an
     * `addConsumer` callback so tests can stub without faking the
     * whole `JetStreamManager.consumers` shape.
     */
    addConsumer?: (stream: string, opts: Record<string, unknown>) => Promise<unknown>;
  };
  readonly js: JetStreamClientLike;
  /** Stream name. */
  readonly streamName: string;
  /** Logger override. */
  readonly logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
  };
}

export function buildNatsPullConsumerFactory(deps: NatsPullConsumerFactoryDeps): ConsumerFactory {
  return async (resolved, onMsg) => {
    const consumerOpts: Record<string, unknown> = {
      durable_name: resolved.consumerName,
      filter_subject: resolved.subject,
      ack_policy: 'explicit',
      // Bound redelivery so a buggy createAgentTask can't loop
      // forever. Operators tune via Helm values.events.maxDeliver.
      max_deliver: 5,
      // 30s ack-deadline; sufficient slack for K8s API latency on
      // AgentTask creation while still bounding stuck deliveries.
      ack_wait: 30_000_000_000, // 30s in ns
    };
    if (typeof deps.jsm.addConsumer === 'function') {
      try {
        await deps.jsm.addConsumer(deps.streamName, consumerOpts);
      } catch (err) {
        // `add` against an existing consumer with matching config is
        // a no-op in v2.29.3; mismatched config surfaces as an API
        // error. Log + proceed — `consumers.get` below will fail
        // loudly if the consumer truly isn't there.
        deps.logger?.warn(
          `[kagent-events] consumers.add raised for ${resolved.consumerName} (existing config drift?): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const consumer = await deps.js.consumers.get(deps.streamName, resolved.consumerName);
    const messages = await consumer.consume({ callback: onMsg });
    return {
      close: async () => {
        try {
          await messages.close();
        } catch (err) {
          deps.logger?.warn(
            `[kagent-events] consumer ${resolved.consumerName} close raised: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    };
  };
}

/* =====================================================================
 * AgentTask creator — turns a delivered event into a K8s AgentTask CR.
 * ===================================================================== */

export interface BuildAgentTaskCreatorDeps {
  readonly customApi: CustomObjectsApi;
  /**
   * Optional clock override for deterministic test names.
   */
  readonly now?: () => Date;
  /**
   * Optional name suffix override — defaults to a 6-hex random
   * string. Production uses `crypto.randomUUID().slice(0, 6)`.
   */
  readonly randomSuffix?: () => string;
  readonly logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
  };
}

export function buildEventTriggerAgentTaskCreator(
  deps: BuildAgentTaskCreatorDeps,
): AgentTaskCreator {
  const now = deps.now ?? ((): Date => new Date());
  const suffix =
    deps.randomSuffix ??
    ((): string => {
      const buf = new Uint8Array(3);
      globalThis.crypto.getRandomValues(buf);
      return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    });
  return async (sub, event) => {
    const manifest = renderEventTriggerAgentTask({
      sub,
      event,
      now: now(),
      randomSuffix: suffix(),
    });
    try {
      await deps.customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: manifest.metadata.namespace,
        plural: AGENT_TASK_PLURAL,
        body: manifest,
      });
      deps.logger?.info(
        `[kagent-events] AgentTask minted from event ${sub.subject} → ${manifest.metadata.namespace}/${manifest.metadata.name} (event id=${event.id})`,
      );
    } catch (err) {
      // Re-throw so the dispatcher's nak-loop can retry.
      throw new Error(
        `event-trigger AgentTask create failed (event id=${event.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

/**
 * Pure renderer — builds the AgentTask manifest for a delivered
 * event. Exported for unit tests.
 *
 * Naming: `<agentName>-evt-<unix-seconds>-<6hex>`. Same shape as
 * `triggers/render-task.ts`'s schedule trigger but with `evt-`
 * marker so `kubectl get agenttasks` distinguishes routes.
 */
export interface RenderEventTriggerInput {
  readonly sub: ResolvedEventSubscription;
  readonly event: KagentCloudEvent<unknown>;
  readonly now: Date;
  readonly randomSuffix: string;
}

const KAGENT_API_VERSION = `${API_GROUP}/${API_VERSION}` as const;
const AGENT_TASK_NAME_MAX_LEN = 63;
/** Annotation carrying the source event id for forensic correlation. */
export const EVENT_ID_ANNOTATION = 'kagent.knuteson.io/event-id' as const;
/** Annotation carrying the resolved consumer name. */
export const EVENT_CONSUMER_ANNOTATION = 'kagent.knuteson.io/event-consumer' as const;

export function renderEventTriggerAgentTask(input: RenderEventTriggerInput): {
  readonly apiVersion: typeof KAGENT_API_VERSION;
  readonly kind: 'AgentTask';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations: Readonly<Record<string, string>>;
  };
  readonly spec: Record<string, unknown>;
} {
  const { sub, event, now, randomSuffix } = input;
  const unixSec = Math.floor(now.getTime() / 1000);
  const baseName = `${sub.agentName}-evt-${String(unixSec)}-${randomSuffix}`;
  const name = baseName.slice(0, AGENT_TASK_NAME_MAX_LEN);
  const labels: Record<string, string> = {
    [EVENT_TRIGGER_LABEL]: 'true',
    [EVENT_TRIGGER_LABEL_TOPIC]: sub.topic,
    'kagent.knuteson.io/managed-by': EVENT_TRIGGER_MANAGED_BY_VALUE,
    'kagent.knuteson.io/agent': sub.agentName,
  };
  const annotations: Record<string, string> = {
    [EVENT_ID_ANNOTATION]: event.id,
    [EVENT_CONSUMER_ANNOTATION]: sub.consumerName,
  };
  // Bind the event payload onto the typed-input pipeline when the
  // subscription declared `inputBinding`. Otherwise forward as
  // payload (legacy / opaque).
  const spec: Record<string, unknown> = {
    targetAgent: sub.agentName,
  };
  if (sub.inputBinding !== undefined) {
    spec.payload = { __event_trigger__: true };
    spec.inputs = [
      {
        name: sub.inputBinding.inputName,
        from: { scalar: event.data },
      },
    ];
  } else {
    spec.payload = event.data;
  }
  // Mirror the placeholder-cap pattern from
  // triggers/render-task.ts — Wave 2 caps land per-trigger; until
  // then, event-trigger AgentTasks carry the same placeholder.
  annotations['kagent.knuteson.io/placeholder-cap'] = 'wave0-shared-all-rights';
  return {
    apiVersion: KAGENT_API_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace: sub.agentNamespace,
      labels,
      annotations,
    },
    spec,
  };
}
