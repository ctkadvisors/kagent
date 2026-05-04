/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/events` — Wave 3 Events sub-team public surface.
 *
 * See `types.ts` for the rationale + envelope shape, `validate.ts` for
 * the topic-cap subset check + payload-validator registry, and
 * `publisher.ts` / `dispatcher.ts` for the runtime wiring (NATS
 * JetStream).
 *
 * Three audiences consume this package:
 *
 *   1. **agent-pod** — `publish_event` built-in tool wraps
 *      `EventPublisher.publish()`. The cap-claim subset check
 *      (`isTopicAdmittedByPublishClaims`) is the in-pod gate.
 *   2. **operator** — admission validates `Agent.spec.publishes` /
 *      `subscribes` against the Agent's `capabilityClaims`; main.ts
 *      provisions the `kagent-events` JetStream stream + per-
 *      subscription pull consumers via `EventDispatcher`.
 *   3. **downstream consumers** — anyone who imports this package as
 *      `@kagent/events` to consume the typed envelope.
 *
 * The substrate intentionally does NOT pin any *application* event
 * types — the Wave 3 brief calls out three EXAMPLE types but a
 * publisher's `Agent.spec.publishes[].topic` is the registration
 * surface. `EventValidator` is the optional in-process JSON-shape
 * gate the publisher / subscriber can both consult.
 */

export {
  DEFAULT_EVENTS_MAX_AGE_MS,
  DEFAULT_EVENTS_STREAM_NAME,
  EVENTS_SUBJECT_PREFIX,
  eventSubject,
  isValidTopic,
  validateTopic,
} from './types.js';
export type {
  KagentCloudEvent,
  TopicValidationError,
  TopicValidationOk,
  TopicValidationResult,
} from './types.js';

export {
  buildEventValidatorRegistry,
  isTopicAdmittedByPublishClaims,
  isTopicAdmittedBySubscribeClaims,
  publishesAreSubsetOfClaims,
  subscribesAreSubsetOfClaims,
  topicSubsetViolations,
} from './validate.js';
export type {
  EventTopicSubsetViolation,
  EventValidator,
  EventValidatorRegistry,
} from './validate.js';

export { buildCloudEvent, makeCloudEvent } from './make-event.js';
export type { MakeCloudEventInput, MakeCloudEventOpts } from './make-event.js';

export { EventPublisher } from './publisher.js';
export type {
  EventConnectFn,
  EventLogger,
  EventNatsConnectionLike,
  EventPublisherOptions,
  PublishInput,
} from './publisher.js';

export {
  buildEventDispatcher,
  computeConsumerName,
  EVENT_TRIGGER_LABEL_TOPIC,
  EVENT_TRIGGER_LABEL,
  EVENT_TRIGGER_MANAGED_BY_VALUE,
} from './dispatcher.js';
export type {
  AgentTaskCreator,
  ConsumerFactory,
  ConsumerSubscription,
  EventDispatcher,
  EventDispatcherDeps,
  EventDispatcherStartOptions,
  EventSubscription,
  EventTriggerInputBindingTemplate,
  JetStreamMsgLike,
  ResolvedEventSubscription,
} from './dispatcher.js';
