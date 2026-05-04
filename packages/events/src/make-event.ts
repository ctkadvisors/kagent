/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `makeCloudEvent` — pure builder for a Wave 3 events envelope.
 *
 * Mirrors the audit-events `makeEvent` builder so the two streams have
 * one envelope shape on the wire. Differences kept narrow:
 *
 *   - `type` is application-defined here (any reverse-DNS-ish string),
 *     where audit's `type` is a closed string-literal union.
 *   - `subject` is OPTIONAL (audit always carries it). When undefined,
 *     the field is OMITTED from the emitted envelope so downstream
 *     consumers don't see `subject: ""`.
 *   - `source` defaults to `kagent.knuteson.io/agent-pod/<agentName>/<taskUid>`
 *     when both fields are supplied. Callers that don't have the
 *     full identity (operator-side smoke emits) pass an explicit
 *     `source`.
 *
 * Pure: no I/O, no globals, no mutation. `Date.now()` and
 * `crypto.randomUUID()` are the only ambient inputs and both are
 * injectable via `opts.now` / `opts.id` for deterministic tests.
 */

import { randomUUID } from 'node:crypto';

import type { KagentCloudEvent } from './types.js';

/**
 * Inputs to `makeCloudEvent`. Application-defined `type` + `data`,
 * optional `source` / `subject`. The substrate stamps `specversion`,
 * `id`, `time`, `datacontenttype` per the CE v1.0 spec — keeping the
 * envelope shape uniform across every emitter.
 */
export interface MakeCloudEventInput<T = unknown> {
  /**
   * Application-defined event type — convention is reverse-DNS-ish,
   * mirrors the publisher's `Agent.spec.publishes[].topic`. Validated
   * by the topic-regex in `types.ts:validateTopic`.
   */
  readonly type: string;
  /**
   * URI-reference identifying the producer. Convention:
   * `kagent.knuteson.io/agent-pod/<agentName>/<taskUid>` (set by the
   * `publish_event` tool; agents NEVER set this themselves).
   */
  readonly source: string;
  /**
   * Optional CloudEvents `subject` — the resource the event is about.
   * Convention: `<Kind>/<namespace>/<name>` (e.g.
   * `AgentTask/default/researcher-1`). When undefined, the field is
   * omitted from the envelope (NOT emitted as empty-string) so
   * downstream consumers can rely on `'subject' in event` as the
   * presence test.
   */
  readonly subject?: string;
  /** Application payload — substrate-opaque; validators run elsewhere. */
  readonly data: T;
}

/**
 * Test-time injection points. Production callers leave both unset and
 * pick up the real `Date.now()` + `randomUUID()`.
 */
export interface MakeCloudEventOpts {
  /** Override the current time. Receives no args, returns a Date or epoch ms. */
  readonly now?: () => Date | number;
  /** Override the random UUID. Receives no args, returns a non-empty string. */
  readonly id?: () => string;
}

/**
 * Build a CloudEvents v1.0 envelope around the substantive event data.
 * Identical conformance to the audit-events `makeEvent` builder —
 * `specversion: '1.0'`, RFC 4122 v4 UUID id, ISO 8601 UTC time,
 * `datacontenttype: 'application/json'`. Returns a typed
 * `KagentCloudEvent<T>`.
 *
 * Why two builders (this + audit's): audit's `type` is a closed string
 * union (the substrate's catalog of decisions), so a generic builder
 * would lose the discriminated narrowing on `event.data`. Wave 3
 * events have an open `type` surface — separate builders keep both
 * type-systems honest. The two emit identical JSON shapes when the
 * `subject` field is set on both.
 */
export function makeCloudEvent<T>(
  input: MakeCloudEventInput<T>,
  opts: MakeCloudEventOpts = {},
): KagentCloudEvent<T> {
  const idValue = opts.id !== undefined ? opts.id() : randomUUID();
  const nowValue = opts.now !== undefined ? opts.now() : Date.now();
  const timeValue =
    nowValue instanceof Date ? nowValue.toISOString() : new Date(nowValue).toISOString();

  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw new Error('makeCloudEvent: input.type must be a non-empty string');
  }
  if (typeof input.source !== 'string' || input.source.length === 0) {
    throw new Error('makeCloudEvent: input.source must be a non-empty string');
  }

  const envelope: KagentCloudEvent<T> = {
    specversion: '1.0',
    id: idValue,
    type: input.type,
    source: input.source,
    ...(typeof input.subject === 'string' &&
      input.subject.length > 0 && { subject: input.subject }),
    time: timeValue,
    datacontenttype: 'application/json',
    data: input.data,
  };
  return envelope;
}

/**
 * Alias for `makeCloudEvent` that mirrors the audit-events
 * `buildCapabilityJwt` / `buildEvent` naming convention. Keeps callsites
 * uniform between the two packages — both `import { buildCloudEvent }`
 * + `buildCapabilityJwt` read as builders, not factories.
 */
export const buildCloudEvent = makeCloudEvent;
