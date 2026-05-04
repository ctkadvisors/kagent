/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `makeEvent` — pure builder for CloudEvents v1.0 envelopes.
 *
 * Every audit emission flows through this fn. Callers provide the
 * substantive fields (`type`, `subject`, `source`, `data`); the builder
 * stamps `specversion`, `id`, `time`, `datacontenttype` per spec —
 * keeping the envelope shape uniform across every emission site so
 * downstream consumers (warehouse, alerting, SOC2 reporting) never see
 * drift.
 *
 * Pure: no I/O, no globals, no mutation. The only ambient input is
 * `Date.now()` (for the `time` field) and `crypto.randomUUID()` (for
 * `id`). Both are injectable via `opts.now` / `opts.id` for tests.
 */

import { randomUUID } from 'node:crypto';

import type { AuditEventData, CloudEvent } from './types.js';

/**
 * Inputs to `makeEvent`. `type` + `data` are paired via the
 * discriminated union — passing a `type: 'task.admitted'` requires
 * `data: TaskAdmittedData`, mismatches surface as a TypeScript error
 * at the call site.
 */
export type MakeEventInput = AuditEventData & {
  /**
   * URI-reference identifying the producer. Convention:
   * `kagent.knuteson.io/<component>` where `<component>` is one of
   * `operator | agent-pod | gateway | capability-issuer`.
   */
  readonly source: string;
  /**
   * Optional CloudEvents `subject` — the resource the event is
   * about. Convention for this substrate:
   * `<Kind>/<namespace>/<name>` (e.g. `AgentTask/default/researcher-1`).
   * Provide an explicit value at every call site so downstream
   * filtering can use it as a primary index; we don't fabricate a
   * default to keep the contract honest.
   */
  readonly subject: string;
};

/**
 * Pick the matching CloudEvent envelope type for a given event-type
 * literal. Used by `makeEvent`'s return type so callers passing a
 * narrow type literal (e.g. `TASK_ADMITTED`) get back a narrow envelope
 * (`CloudEvent<TaskAdmittedData> & { type: 'task.admitted' }`),
 * NOT the full discriminated union — and `event.data.<field>` is
 * therefore typed without needing a `switch (event.type)` first.
 */
type EnvelopeFor<K extends AuditEventData['type']> = CloudEvent<
  Extract<AuditEventData, { type: K }>['data']
> & { type: K };

/**
 * Test-time injection points. Production callers leave both unset and
 * pick up the real `Date.now()` + `randomUUID()`.
 */
export interface MakeEventOpts {
  /** Override the current time. Receives no args, returns a Date or epoch ms. */
  readonly now?: () => Date | number;
  /** Override the random UUID. Receives no args, returns a non-empty string. */
  readonly id?: () => string;
}

/**
 * Build a CloudEvents v1.0 envelope around the substantive event data.
 *
 * Conformance:
 *   - `specversion` is the literal string `"1.0"` per CE spec §3.
 *   - `id` is a fresh RFC 4122 v4 UUID per emission. Collisions are
 *     not a substrate concern: the audit warehouse uses `(source, id)`
 *     as the dedupe key.
 *   - `time` is RFC 3339 (ISO 8601) UTC — `Date.toISOString()`'s exact
 *     format. The CE spec mandates RFC 3339; toISOString conforms.
 *   - `datacontenttype` is locked at `"application/json"` because we
 *     always marshal `data` via `JSON.stringify` on the publish path.
 *
 * Order in the returned object follows the CE spec listing — keeps
 * snapshot tests readable.
 */
export function makeEvent<T extends MakeEventInput>(
  input: T,
  opts: MakeEventOpts = {},
): EnvelopeFor<T['type']> {
  const idValue = opts.id !== undefined ? opts.id() : randomUUID();
  const nowValue = opts.now !== undefined ? opts.now() : Date.now();
  const timeValue =
    nowValue instanceof Date ? nowValue.toISOString() : new Date(nowValue).toISOString();

  // The generic parameter `T extends MakeEventInput` keeps the (type,
  // data) pair narrowed at the call site: passing `type: TASK_ADMITTED`
  // narrows `T['type']` to `'task.admitted'` and `T['data']` to
  // `TaskAdmittedData`. Returning `EnvelopeFor<T['type']>` projects
  // that narrowing onto the envelope so callers can `event.data.<field>`
  // directly without a `switch (event.type)` first. The cast bridges
  // structural-typing reality (the assembled object is in fact the
  // narrow envelope) to the generic projection.
  const envelope = {
    specversion: '1.0' as const,
    id: idValue,
    type: input.type,
    source: input.source,
    subject: input.subject,
    time: timeValue,
    datacontenttype: 'application/json' as const,
    data: input.data,
  };
  return envelope as EnvelopeFor<T['type']>;
}
