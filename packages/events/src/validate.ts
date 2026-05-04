/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Topic-cap subset checks + a tiny per-topic payload validator
 * registry.
 *
 * Two distinct gates surface here:
 *
 *   1. **Topic ACL** — `Agent.spec.publishes[].topic` MUST be admitted
 *      by the Agent's `capabilityClaims.publish` glob list.
 *      Symmetrically for `subscribes` against `claims.subscribe`. The
 *      operator's admission validator + the in-pod `publish_event`
 *      tool both call these — fail-closed at admission keeps malformed
 *      Agent specs off the substrate; defense-in-depth in-pod stops a
 *      compromised pod from publishing on a topic outside its claim.
 *
 *   2. **Payload schema** — a per-topic application-layer JSON-shape
 *      validator. The Wave 3 brief locks `EventValidator` as an
 *      OPTIONAL surface — substrate emits a CloudEvents envelope
 *      regardless, validators are application-pluggable so consumers
 *      can register `{ topic, validate(data) → ok | error }` pairs
 *      without the substrate having to know the schema. Used by
 *      `EventPublisher.publish` when a validator is registered for
 *      the topic; absent registration = unvalidated emission.
 *
 * Glob semantics for the ACL check are the same dialect as
 * `@kagent/capability-types/glob-match` (`*` only) — re-using the
 * subset-test helper there keeps the authority surface uniform across
 * spawn / read / write / publish / subscribe categories.
 */

import { globMatchAny } from '@kagent/capability-types';

import { isValidTopic, validateTopic } from './types.js';

/* =====================================================================
 * Topic ⊆ cap-claim subset checks.
 *
 * "Subset" here is a CONCRETE topic (`research.findings`) being
 * admitted by a glob list (`['research.*', 'audit.*']`). The opposite
 * direction (glob-vs-glob subset) lives in
 * `@kagent/capability-types/glob-match.globPatternIsSubset` for the
 * cap-narrowing path; agents don't declare globs in publishes /
 * subscribes (they declare exact topics), so glob-match is enough.
 * ===================================================================== */

/**
 * Is this concrete topic admitted by ANY pattern in the publish-claim
 * glob list? Returns false for empty / undefined claims (fail-closed,
 * matches `globMatchAny`'s contract).
 *
 * Used by:
 *   - operator admission: every `Agent.spec.publishes[].topic` runs
 *     through this against the same Agent's `capabilityClaims.publish`.
 *     Mismatch = admission rejects the Agent CR.
 *   - agent-pod `publish_event` tool: defense-in-depth re-check
 *     against the mounted capability bundle's `claims.publish`.
 */
export function isTopicAdmittedByPublishClaims(
  topic: string,
  publishClaims: readonly string[] | undefined,
): boolean {
  if (!isValidTopic(topic)) return false;
  return globMatchAny(publishClaims, topic);
}

/**
 * Symmetric variant for `subscribe` claims. The operator side calls
 * this on every `Agent.spec.subscribes[].topic` to gate event-trigger
 * registration — a subscribe declaration whose topic isn't in
 * `claims.subscribe` admission-fails (operator never opens a NATS
 * pull-consumer for a denied subscription).
 */
export function isTopicAdmittedBySubscribeClaims(
  topic: string,
  subscribeClaims: readonly string[] | undefined,
): boolean {
  if (!isValidTopic(topic)) return false;
  return globMatchAny(subscribeClaims, topic);
}

/* =====================================================================
 * Bulk subset checks — admission-side conveniences.
 *
 * Admission walks every `Agent.spec.publishes[].topic` and
 * `Agent.spec.subscribes[].topic`; these helpers return the violations
 * (empty = subset holds) so admission can build a structured rejection
 * message listing every topic that's outside the cap claim.
 * ===================================================================== */

export interface EventTopicSubsetViolation {
  /** Which side of the ACL the topic belongs to. */
  readonly category: 'publish' | 'subscribe';
  /** The concrete topic that wasn't admitted. */
  readonly topic: string;
  /** Reason — either malformed topic, or outside the claim list. */
  readonly reason: 'invalid_topic' | 'not_admitted_by_claims';
}

/**
 * Walk every entry in `publishes[]` against the publish-claim list.
 * Returns the set of violations (empty = subset holds). Order-preserving
 * so admission's error string matches the order of the input list.
 */
export function publishesAreSubsetOfClaims(
  topics: readonly string[],
  publishClaims: readonly string[] | undefined,
): readonly EventTopicSubsetViolation[] {
  return collectViolations(topics, publishClaims, 'publish');
}

/** Same shape as `publishesAreSubsetOfClaims` but for the subscribe side. */
export function subscribesAreSubsetOfClaims(
  topics: readonly string[],
  subscribeClaims: readonly string[] | undefined,
): readonly EventTopicSubsetViolation[] {
  return collectViolations(topics, subscribeClaims, 'subscribe');
}

/**
 * Combined helper — walks publishes + subscribes in one call, returns
 * a single violations array. Convenient for admission's one-shot
 * "every topic ⊆ its respective claim" check.
 */
export function topicSubsetViolations(input: {
  readonly publishes?: readonly string[];
  readonly subscribes?: readonly string[];
  readonly publishClaims?: readonly string[];
  readonly subscribeClaims?: readonly string[];
}): readonly EventTopicSubsetViolation[] {
  const out: EventTopicSubsetViolation[] = [];
  out.push(...publishesAreSubsetOfClaims(input.publishes ?? [], input.publishClaims));
  out.push(...subscribesAreSubsetOfClaims(input.subscribes ?? [], input.subscribeClaims));
  return out;
}

function collectViolations(
  topics: readonly string[],
  claims: readonly string[] | undefined,
  category: 'publish' | 'subscribe',
): readonly EventTopicSubsetViolation[] {
  const out: EventTopicSubsetViolation[] = [];
  for (const t of topics) {
    const tv = validateTopic(t);
    if (!tv.ok) {
      out.push({ category, topic: typeof t === 'string' ? t : String(t), reason: 'invalid_topic' });
      continue;
    }
    if (!globMatchAny(claims, t)) {
      out.push({ category, topic: t, reason: 'not_admitted_by_claims' });
    }
  }
  return out;
}

/* =====================================================================
 * Per-topic payload validators.
 *
 * The Wave 3 brief carves payload schemas as APPLICATION-LAYER —
 * substrate emits the CloudEvents envelope, applications register
 * validators against the topics they care about. The registry below
 * is a thin convenience for that pattern; absent a registered
 * validator, a topic is unvalidated (publish accepts any JSON-
 * serializable data).
 *
 * The Wave 3 brief deliverable 1 names three example types
 * (`research.findings`, `task.review_requested`, `task.handoff`) so
 * the shape is concrete; the substrate doesn't pin them. Consumers
 * register with `registry.set(topic, validator)` at app boot.
 * ===================================================================== */

/**
 * A validator returns `ok: true` for accepted payloads, `ok: false`
 * with a structured error otherwise. The publisher calls
 * `validator(data)` and refuses to publish on error — keeps malformed
 * payloads off the stream so subscribers don't have to defensively
 * guard.
 */
export type EventValidator = (data: unknown) =>
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
    };

/**
 * Per-topic validator registry. Topics use the same dialect as
 * `validateTopic` (lowercase reverse-DNS); registration with an
 * invalid topic throws.
 */
export interface EventValidatorRegistry {
  set(topic: string, validator: EventValidator): void;
  get(topic: string): EventValidator | undefined;
  has(topic: string): boolean;
  /**
   * Run the validator (if any) for `topic` against `data`. Returns
   * `ok: true` when no validator is registered (unvalidated topic).
   */
  validate(topic: string, data: unknown): ReturnType<EventValidator>;
}

/** Build a fresh validator registry. Pure — no globals. */
export function buildEventValidatorRegistry(): EventValidatorRegistry {
  const map = new Map<string, EventValidator>();
  return {
    set(topic, validator) {
      const tv = validateTopic(topic);
      if (!tv.ok) {
        throw new Error(`buildEventValidatorRegistry.set: ${tv.error}`);
      }
      map.set(topic, validator);
    },
    get(topic) {
      return map.get(topic);
    },
    has(topic) {
      return map.has(topic);
    },
    validate(topic, data) {
      const v = map.get(topic);
      if (v === undefined) return { ok: true };
      return v(data);
    },
  };
}
