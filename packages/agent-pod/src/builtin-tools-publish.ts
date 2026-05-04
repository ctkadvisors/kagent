/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 Events sub-team — `publish_event` built-in tool.
 *
 * Per docs/SUBSTRATE-V1.md §3.7 + WAVES.md §5.1 deliverable 4: the
 * agent loop publishes typed CloudEvents on `kagent.events.<topic>`.
 * The tool wraps `@kagent/events:EventPublisher.publish` and
 * surfaces structured error text to the LLM on cap-denial / topic-
 * validation failures (mirrors the `policy_denied:` taxonomy from
 * `defineSpawnChildTask`).
 *
 * Trust boundary (defense-in-depth on top of operator admission):
 *
 *   1. The `topic` is validated by `@kagent/events:validateTopic`.
 *      Reverse-DNS lowercase only; no NATS wildcards.
 *   2. The publisher's `publishClaims` (sourced from the mounted
 *      capability bundle's `claims.publish`) gates emission. Refusal
 *      surfaces as `policy_denied:capability_violation`.
 *   3. When the capability bundle declares NO `claims.publish`, the
 *      tool refuses every emission with `policy_denied:no_publish_claims`.
 *      Mirrors the spawn-tool's "fail-closed when no allowedChildAgents"
 *      pattern.
 *   4. Topic also MUST be in the Agent's declared `publishes[]`
 *      list (operator admission validates this; this tool re-checks
 *      so a CRD-update race that drops a topic from `publishes` is
 *      caught in-pod).
 *
 * Wire pattern mirrors `defineSpawnChildTask` / `defineGetMyContext`:
 * a separate factory function (vs. an entry in
 * `buildBuiltinToolRegistry`) because the dependencies are
 * per-task-instance — the `EventPublisher` is constructed once at
 * runner boot from `KAGENT_EVENTS_NATS_URL` env + the loaded
 * capability claims. The runner stitches the result into the
 * `kagent-substrate` provider alongside `spawn_child_task`.
 */

import type { ContentBlock } from '@kagent/agent-loop';
import type { CapabilityBundle } from '@kagent/capability-types';
import type { EventPublisher, KagentCloudEvent } from '@kagent/events';
import { defineInProcessTool } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

/** Cap on the JSON-encoded `data` payload (bytes). */
export const PUBLISH_EVENT_MAX_DATA_BYTES = 64 * 1024; // 64 KiB
/** Cap on `subject` length (CloudEvents `subject` is a string ref). */
export const PUBLISH_EVENT_MAX_SUBJECT_LEN = 256;

export interface PublishEventDeps {
  /**
   * Pre-constructed publisher (operator-injected env: NATS URL,
   * source URI, validators, etc.). The tool calls `publisher.publish()`
   * verbatim.
   */
  readonly publisher: EventPublisher;
  /**
   * Decoded capability bundle (loaded by `cap-consumer.loadCapabilityFromEnv`)
   * — provides `claims.publish` for the in-pod cap-check. When undefined
   * (legacy / no-cap pod), the tool refuses every emission with
   * `policy_denied:no_capability` so a misconfigured pod can't accidentally
   * skip the cap gate.
   */
  readonly capabilityBundle: CapabilityBundle | undefined;
  /**
   * Whitelist of topics declared on `Agent.spec.publishes[].topic`.
   * Defense in depth: even when the cap claim admits a topic, this
   * tool refuses to publish on topics the Agent didn't declare —
   * keeps the GitOps Agent spec the authoritative declaration of
   * what an Agent emits.
   */
  readonly declaredPublishes: ReadonlySet<string>;
}

interface PublishArgs {
  readonly topic: string;
  readonly data: unknown;
  readonly subject?: string;
}

/**
 * Build the `publish_event` tool definition. Returns an
 * `InProcessToolDefinition` the caller stitches into a
 * `ToolProvider` (or registers via the substrate-tools provider in
 * main.ts). The handler is async because `publisher.publish()`
 * awaits NATS flush, but pure with respect to other in-pod state.
 */
export function definePublishEvent(deps: PublishEventDeps): InProcessToolDefinition {
  const { publisher, capabilityBundle, declaredPublishes } = deps;
  return defineInProcessTool({
    name: 'publish_event',
    description:
      'Publish a typed event onto the kagent.events.<topic> stream. ' +
      'Topic MUST be one declared on this Agent.spec.publishes[] AND ' +
      "admitted by this Agent's cap.claims.publish. Returns " +
      '{id, subject, type, time, source} on success. Refuses with ' +
      'policy_denied: when the topic is undeclared, malformed, or ' +
      'outside the cap claim. Use this for loose-coordination ' +
      'pub/sub flows; for direct child spawn use spawn_child_task.',
    inputSchema: {
      type: 'object',
      required: ['topic', 'data'],
      properties: {
        topic: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description:
            'Reverse-DNS-ish topic — lowercase ASCII letters/digits/_-, dot-separated. ' +
            'No NATS wildcards (* or >). Example: "research.findings".',
        },
        data: {
          description:
            'Application payload. Forwarded verbatim as the ' +
            "CloudEvents envelope's `data` field. Capped at 64 KiB JSON-encoded.",
        },
        subject: {
          type: 'string',
          minLength: 1,
          maxLength: PUBLISH_EVENT_MAX_SUBJECT_LEN,
          description:
            'Optional CloudEvents `subject` — the resource the event is about ' +
            '(`AgentTask/<ns>/<name>`, `Workspace/<ns>/<name>`, ...). Omit when ' +
            'the event is a pure topic broadcast.',
        },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'events', 'write'],
    handler: async (rawArgs) => {
      const args = parsePublishArgs(rawArgs);

      // Guardrail 1 — capability bundle MUST be mounted. A pod
      // without a cap can't publish; mirrors spawn-tool's
      // fail-closed-when-empty posture.
      if (capabilityBundle === undefined) {
        throw new Error(
          'policy_denied:no_capability — publish_event requires a mounted capability bundle (set KAGENT_CAP_JWT_FILE on the deployment)',
        );
      }
      const publishClaims = capabilityBundle.claims.publish ?? [];
      if (publishClaims.length === 0) {
        throw new Error(
          `policy_denied:no_publish_claims — capability bundle (jti=${capabilityBundle.jti}) has no claims.publish; topic="${args.topic}" cannot be emitted`,
        );
      }

      // Guardrail 2 — topic MUST be on the Agent's declared
      // `publishes[]` list. Defense in depth: catches the CRD-update
      // race where the cap still admits the topic but the Agent's
      // GitOps spec dropped the declaration.
      if (!declaredPublishes.has(args.topic)) {
        const knownList = Array.from(declaredPublishes).sort().join(', ');
        throw new Error(
          `policy_denied:topic_not_declared — topic="${args.topic}" is not in Agent.spec.publishes[] (declared: ${knownList || '<none>'})`,
        );
      }

      // Guardrail 3 — payload size cap. Computed against the
      // JSON-encoded form so the cap matches what NATS sees.
      let payloadBytes: number;
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(args.data), 'utf8');
      } catch (err) {
        throw new Error(
          `validation_failed: data must be JSON-serializable (${describeError(err)})`,
        );
      }
      if (payloadBytes > PUBLISH_EVENT_MAX_DATA_BYTES) {
        throw new Error(
          `policy_denied:payload_too_large — data is ${String(payloadBytes)} bytes, cap=${String(PUBLISH_EVENT_MAX_DATA_BYTES)}`,
        );
      }

      // Guardrail 4 — `EventPublisher.publish` runs the cap-claim
      // glob check (it was constructed with `publishClaims` set to
      // `capabilityBundle.claims.publish`). It also runs any
      // registered topic-payload validator. Both surfaces throw —
      // we let those propagate so the LLM sees the structured error.
      let result: Awaited<ReturnType<typeof publisher.publish<unknown>>>;
      try {
        result = await publisher.publish({
          topic: args.topic,
          data: args.data,
          ...(args.subject !== undefined && { subject: args.subject }),
        });
      } catch (err) {
        // Translate the publisher's authority-class errors into the
        // `policy_denied:` taxonomy the LLM expects from substrate
        // tools.
        const msg = describeError(err);
        if (/not admitted by capability/.test(msg)) {
          throw new Error(`policy_denied:capability_violation — ${msg}`);
        }
        if (/invalid topic/.test(msg)) {
          throw new Error(`policy_denied:invalid_topic — ${msg}`);
        }
        if (/failed validator/.test(msg)) {
          throw new Error(`validation_failed: ${msg}`);
        }
        throw err;
      }

      if (!result.ok) {
        // Infra-class failure (NATS unreachable). Surface as
        // `infra_unavailable:` so the LLM doesn't re-loop on the
        // same publish.
        throw new Error(
          `infra_unavailable:${result.reason} — publish dropped (best-effort); see operator logs`,
        );
      }
      return jsonContent(buildToolResult(result.event, result.subject));
    },
  });
}

interface ToolResult {
  readonly ok: true;
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly time: string;
  readonly subject: string;
  readonly resourceSubject?: string;
}

function buildToolResult(event: KagentCloudEvent<unknown>, subject: string): ToolResult {
  return {
    ok: true,
    id: event.id,
    type: event.type,
    source: event.source,
    time: event.time,
    subject,
    ...(typeof event.subject === 'string' && { resourceSubject: event.subject }),
  };
}

function parsePublishArgs(args: Record<string, unknown>): PublishArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('publish_event: args must be an object');
  }
  const topic = args.topic;
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('publish_event: "topic" must be a non-empty string');
  }
  const data = args.data;
  if (data === undefined) {
    throw new Error('publish_event: "data" is required');
  }
  const subjectRaw = args.subject;
  const subject = typeof subjectRaw === 'string' && subjectRaw.length > 0 ? subjectRaw : undefined;
  return {
    topic,
    data,
    ...(subject !== undefined && { subject }),
  };
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
