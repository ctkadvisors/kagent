/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/events` — typed pub/sub envelope + topic conventions for the
 * substrate Event primitive (per docs/SUBSTRATE-V1.md §3.7 +
 * docs/WAVES.md §5.1).
 *
 * The Event primitive is the **loose-coordination** surface — typed
 * pub/sub on NATS JetStream, decoupled from explicit parent/child
 * AgentTask trees. Two surfaces share one backend:
 *
 *   - **Pub/sub** — typed event streams. `Agent.spec.publishes` /
 *     `Agent.spec.subscribes`. Substrate subjects under
 *     `kagent.events.<topic>`.
 *   - **Blackboard** — task-tree-scoped typed KV. Substrate subjects
 *     under `kagent.kv.*` (Wave 3 / Blackboard sub-team owns).
 *
 * The two namespaces are deliberately disjoint so a misconfigured ACL
 * on one surface can't leak into the other (per WAVES.md §5.6 cross-
 * team coordination).
 *
 * **Wave 3 Events relationship to Wave 0 Audit:** the audit stream
 * (`audit.>`) is the *substrate decision* log; events
 * (`kagent.events.>`) is the *application coordination* log. Both
 * adopt the CloudEvents v1.0 envelope so downstream consumers (Loki,
 * Splunk, Elastic) parse them with one set of connectors. Audit is
 * substrate-emitted; events are application-emitted (via
 * `publish_event` tool, capability-gated).
 *
 * The substrate intentionally does NOT pin application event types —
 * the Wave 3 brief (WAVES.md §5.1 deliverable 1) calls out three
 * EXAMPLE types (`research.findings`, `task.review_requested`,
 * `task.handoff`) so consumers see the shape without the substrate
 * inventing application taxonomy. New event types are added by
 * application-layer schema registration (via the `EventValidator`
 * surface in `validate.ts`).
 */

/**
 * Subject namespace prefix for Wave 3 Events. Every published event
 * lands at `${EVENTS_SUBJECT_PREFIX}.<topic>`. Locked at
 * `kagent.events` per WAVES.md §5.6 — Blackboard owns
 * `kagent.kv.*`, Audit owns `audit.*`. Override only in tests.
 */
export const EVENTS_SUBJECT_PREFIX = 'kagent.events' as const;

/**
 * JetStream stream name the events sub-team provisions. Single stream
 * with subject filter `kagent.events.>` so every event topic shares
 * retention. Override via Helm `events.nats.streamName` only when
 * collocating with another `kagent-events` consumer.
 */
export const DEFAULT_EVENTS_STREAM_NAME = 'kagent-events' as const;

/**
 * Default max-age (24h) on the events stream. Events are coordination
 * data, not durable application state — short retention forces
 * application-layer projection / archival to do its job. Helm value
 * `events.retention.maxAgeMs` overrides.
 */
export const DEFAULT_EVENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Compose the full NATS subject for an event topic. Pure helper —
 * callers MUST go through this so the namespace prefix can never be
 * accidentally elided. `topic` is already validated upstream
 * (`isValidTopic`); this function does not re-check.
 */
export function eventSubject(topic: string, prefix: string = EVENTS_SUBJECT_PREFIX): string {
  return `${prefix}.${topic}`;
}

/**
 * CloudEvents v1.0 envelope for Wave 3 events. Mirrors the shape of
 * `@kagent/audit-events`'s `CloudEvent<T>` so downstream consumers
 * see one envelope across both streams. Differences from the audit
 * envelope:
 *
 *   - `type` is application-defined (any `dot.separated` reverse-DNS
 *     string) — the substrate doesn't enumerate. Topic-namespacing
 *     keeps it flat.
 *   - `subject` is OPTIONAL (audit always carries it). Use it when
 *     the event is "about" a specific resource (`AgentTask/<ns>/<n>`,
 *     `Workflow/<ns>/<n>`, `Workspace/<ns>/<n>`); leave undefined for
 *     pure topic events.
 *   - `source` defaults to the publishing agent's pod identity
 *     (`kagent.knuteson.io/agent-pod/<agentName>/<taskUid>`) so an
 *     audit consumer can correlate event flow back to its emitter.
 */
export interface KagentCloudEvent<T = unknown> {
  readonly specversion: '1.0';
  readonly id: string;
  /**
   * Event type — application-defined reverse-DNS-ish string. The
   * `topic` field on the publisher's `Agent.spec.publishes[]` carries
   * the same value: a publisher whose `topic` is `research.findings`
   * emits CloudEvents with `type: 'research.findings'`. Validators in
   * `validate.ts` keyed on this string.
   */
  readonly type: string;
  /** Producer URI — convention: `kagent.knuteson.io/agent-pod/<agentName>/<taskUid>`. */
  readonly source: string;
  readonly subject?: string;
  /** RFC 3339 timestamp of emission. */
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: T;
}

/**
 * Topic validation — Wave 3 dialect.
 *
 * Allowed:
 *   - lowercase ASCII letters, digits, `_`, `-`
 *   - dots as segment separators (`research.findings`)
 *   - 1..128 chars total; 1..64 per segment
 *
 * Disallowed:
 *   - uppercase (NATS subjects are case-sensitive; force lowercase to
 *     avoid `Research.findings` vs `research.findings` ambiguity)
 *   - whitespace, NUL, control characters
 *   - `*` and `>` (NATS wildcard chars; topics MUST be exact)
 *   - leading/trailing/consecutive dots
 *
 * The CRD admission validator + the `publish_event` tool both call
 * this; rejecting fail-closed at admission keeps malformed topic
 * declarations off the substrate before the agent-pod ever runs.
 */
const TOPIC_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const TOPIC_MAX_LEN = 128;
const TOPIC_SEGMENT_MAX_LEN = 64;

export interface TopicValidationError {
  readonly ok: false;
  readonly error: string;
}

export interface TopicValidationOk {
  readonly ok: true;
}

export type TopicValidationResult = TopicValidationOk | TopicValidationError;

export function validateTopic(raw: unknown): TopicValidationResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'topic must be a non-empty string' };
  }
  if (raw.length > TOPIC_MAX_LEN) {
    return {
      ok: false,
      error: `topic exceeds ${String(TOPIC_MAX_LEN)} chars (got ${String(raw.length)})`,
    };
  }
  if (!TOPIC_RE.test(raw)) {
    return {
      ok: false,
      error:
        `topic "${raw}" must match [a-z0-9_-]+(.[a-z0-9_-]+)* — lowercase ` +
        `ASCII, dot-separated segments, no NATS wildcards (*/>) or whitespace`,
    };
  }
  for (const segment of raw.split('.')) {
    if (segment.length > TOPIC_SEGMENT_MAX_LEN) {
      return {
        ok: false,
        error: `topic segment "${segment}" exceeds ${String(TOPIC_SEGMENT_MAX_LEN)} chars`,
      };
    }
  }
  return { ok: true };
}

export function isValidTopic(raw: unknown): boolean {
  return validateTopic(raw).ok;
}
