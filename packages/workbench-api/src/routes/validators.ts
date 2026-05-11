/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Hand-rolled body validators for the workbench-api write surface.
 *
 * Why no zod: the workbench-api ships zero runtime-validation deps
 * today (`@kagent/dto` is type-only). Adding zod for one POST handler
 * costs ~50KB of bundled JS and a transitive validator package; a
 * 60-line hand validator is clearer at this scale and matches the
 * existing pattern in `auth.ts` / `routes/tasks.ts` (literal field
 * checks, no schema framework). When a second write endpoint lands
 * (e.g. POST /api/agents in WS-M's wake), revisit and consolidate.
 */

import type { CreateTaskRequest, ReplayOfReference } from '../types-write.js';

export type ValidationError =
  | { readonly code: 'missing'; readonly field: string }
  | { readonly code: 'wrong-type'; readonly field: string; readonly expected: string }
  | { readonly code: 'empty'; readonly field: string }
  | { readonly code: 'too-long'; readonly field: string; readonly max: number }
  | {
      readonly code: 'out-of-range';
      readonly field: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly code: 'invalid-name'; readonly field: string }
  | {
      readonly code: 'payload-too-large';
      readonly field: 'payload';
      readonly maxBytes: number;
      readonly actualBytes: number;
    };

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly value?: CreateTaskRequest;
}

/** Per AgentTask CRD: originalUserMessage cap. */
const MAX_MESSAGE_BYTES = 32_768;

/**
 * H16 — `payload` byte cap. The `payload` field is a structurally
 * opaque JSON blob that flows directly into the AgentTask CR's
 * `spec.payload`. Without a size cap a single POST can request a
 * 2 MB CR write that subsequently fails apiserver admission with a
 * 413 *after* hitting the apiserver, wasting the round-trip and
 * potentially OOMing the agent-pod that loads the spec. The 64 KiB
 * cap mirrors the LLM gateway's `MAX_BODY_BYTES` and gives ample room
 * for any task-shaped payload while keeping the worst-case
 * apiserver write small.
 */
export const MAX_PAYLOAD_BYTES = 65_536;

/** K8s name regex (RFC 1123 label subset; lowercase alphanumerics + dashes). */
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,251}[a-z0-9])?$/;

/** K8s namespace regex (same shape as label, max 63 chars). */
const K8S_NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** UUID v4 regex (lowercase hex; case-insensitive match). Phase 5 / WB-03. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max UTF-8 byte length for a replay reason string. Phase 5 / WB-03. */
const MAX_REPLAY_REASON_BYTES = 256;

/**
 * Validate a `POST /api/tasks` request body. Returns `valid: true` with
 * the canonicalized value, or `valid: false` with one or more errors.
 *
 * Required: `targetAgent`, `originalUserMessage`.
 * Optional: `namespace`, `name`, `runConfig.timeoutSeconds`,
 * `runConfig.maxIterations`, `labels`, `payload`.
 */
export function validateCreateTaskBody(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (raw === null || typeof raw !== 'object') {
    return { valid: false, errors: [{ code: 'wrong-type', field: '<body>', expected: 'object' }] };
  }

  const body = raw as Record<string, unknown>;

  // targetAgent — required string, K8s-name shape
  const targetAgent = body.targetAgent;
  if (targetAgent === undefined || targetAgent === null) {
    errors.push({ code: 'missing', field: 'targetAgent' });
  } else if (typeof targetAgent !== 'string') {
    errors.push({ code: 'wrong-type', field: 'targetAgent', expected: 'string' });
  } else if (targetAgent.length === 0) {
    errors.push({ code: 'empty', field: 'targetAgent' });
  } else if (!K8S_NAME_RE.test(targetAgent)) {
    errors.push({ code: 'invalid-name', field: 'targetAgent' });
  }

  // originalUserMessage — required string, capped
  const originalUserMessage = body.originalUserMessage;
  if (originalUserMessage === undefined || originalUserMessage === null) {
    errors.push({ code: 'missing', field: 'originalUserMessage' });
  } else if (typeof originalUserMessage !== 'string') {
    errors.push({ code: 'wrong-type', field: 'originalUserMessage', expected: 'string' });
  } else if (originalUserMessage.length === 0) {
    errors.push({ code: 'empty', field: 'originalUserMessage' });
  } else if (Buffer.byteLength(originalUserMessage, 'utf8') > MAX_MESSAGE_BYTES) {
    errors.push({ code: 'too-long', field: 'originalUserMessage', max: MAX_MESSAGE_BYTES });
  }

  // namespace — optional string, K8s namespace shape
  let namespace: string | undefined;
  if (body.namespace !== undefined && body.namespace !== null) {
    if (typeof body.namespace !== 'string') {
      errors.push({ code: 'wrong-type', field: 'namespace', expected: 'string' });
    } else if (body.namespace.length === 0) {
      errors.push({ code: 'empty', field: 'namespace' });
    } else if (!K8S_NAMESPACE_RE.test(body.namespace)) {
      errors.push({ code: 'invalid-name', field: 'namespace' });
    } else {
      namespace = body.namespace;
    }
  }

  // name — optional string, K8s name shape
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string') {
      errors.push({ code: 'wrong-type', field: 'name', expected: 'string' });
    } else if (body.name.length === 0) {
      errors.push({ code: 'empty', field: 'name' });
    } else if (!K8S_NAME_RE.test(body.name)) {
      errors.push({ code: 'invalid-name', field: 'name' });
    } else {
      name = body.name;
    }
  }

  // runConfig — optional object with timeoutSeconds + maxIterations
  let runConfig: CreateTaskRequest['runConfig'];
  if (body.runConfig !== undefined && body.runConfig !== null) {
    if (typeof body.runConfig !== 'object' || Array.isArray(body.runConfig)) {
      errors.push({ code: 'wrong-type', field: 'runConfig', expected: 'object' });
    } else {
      const rc = body.runConfig as Record<string, unknown>;
      const out: { timeoutSeconds?: number; maxIterations?: number } = {};
      if (rc.timeoutSeconds !== undefined && rc.timeoutSeconds !== null) {
        if (
          typeof rc.timeoutSeconds !== 'number' ||
          !Number.isInteger(rc.timeoutSeconds) ||
          rc.timeoutSeconds < 1 ||
          rc.timeoutSeconds > 86_400
        ) {
          errors.push({
            code: 'out-of-range',
            field: 'runConfig.timeoutSeconds',
            min: 1,
            max: 86_400,
          });
        } else {
          out.timeoutSeconds = rc.timeoutSeconds;
        }
      }
      if (rc.maxIterations !== undefined && rc.maxIterations !== null) {
        if (
          typeof rc.maxIterations !== 'number' ||
          !Number.isInteger(rc.maxIterations) ||
          rc.maxIterations < 1 ||
          rc.maxIterations > 100
        ) {
          errors.push({
            code: 'out-of-range',
            field: 'runConfig.maxIterations',
            min: 1,
            max: 100,
          });
        } else {
          out.maxIterations = rc.maxIterations;
        }
      }
      if (Object.keys(out).length > 0) runConfig = out;
    }
  }

  // labels — optional Record<string,string>, capped at 32 keys, no kagent reserved-prefix
  let labels: Record<string, string> | undefined;
  if (body.labels !== undefined && body.labels !== null) {
    if (typeof body.labels !== 'object' || Array.isArray(body.labels)) {
      errors.push({ code: 'wrong-type', field: 'labels', expected: 'object' });
    } else {
      const ls = body.labels as Record<string, unknown>;
      const keys = Object.keys(ls);
      if (keys.length > 32) {
        errors.push({ code: 'too-long', field: 'labels', max: 32 });
      } else {
        const out: Record<string, string> = {};
        for (const k of keys) {
          if (k.startsWith('kagent.knuteson.io/')) {
            errors.push({ code: 'invalid-name', field: `labels[${k}]` });
            continue;
          }
          const v = ls[k];
          if (typeof v !== 'string') {
            errors.push({ code: 'wrong-type', field: `labels[${k}]`, expected: 'string' });
            continue;
          }
          if (v.length > 63) {
            errors.push({ code: 'too-long', field: `labels[${k}]`, max: 63 });
            continue;
          }
          out[k] = v;
        }
        if (Object.keys(out).length > 0) labels = out;
      }
    }
  }

  // payload — opaque; allow any non-null object/value, capped by
  // serialised JSON byte size (H16). The cap runs ahead of the
  // overall errors-empty check so a too-large payload short-circuits
  // before we hand the manifest to the K8s apiserver.
  const payload = body.payload;
  if (payload !== undefined) {
    let serialised: string;
    try {
      serialised = JSON.stringify(payload);
    } catch {
      // JSON.stringify throws on a circular structure — refuse the
      // request with a clear error rather than letting the K8s client
      // surface a less-actionable 500.
      errors.push({ code: 'wrong-type', field: 'payload', expected: 'JSON-serialisable value' });
      return { valid: false, errors };
    }
    const actualBytes = Buffer.byteLength(serialised, 'utf8');
    if (actualBytes > MAX_PAYLOAD_BYTES) {
      errors.push({
        code: 'payload-too-large',
        field: 'payload',
        maxBytes: MAX_PAYLOAD_BYTES,
        actualBytes,
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    value: {
      targetAgent: targetAgent as string,
      originalUserMessage: originalUserMessage as string,
      ...(namespace !== undefined && { namespace }),
      ...(name !== undefined && { name }),
      ...(runConfig !== undefined && { runConfig }),
      ...(labels !== undefined && { labels }),
      ...(payload !== undefined && { payload }),
    },
  };
}

/**
 * Phase 5 / WB-03 — Validate the optional `replayOf` field of a
 * `POST /api/tasks` request body.
 *
 * This is a sub-helper alongside `validateCreateTaskBody`. It is NOT
 * called from `validateCreateTaskBody` in Plan 01 — Plan 02 adds that
 * call site when it wires the 5-step replay handler in `routes/tasks.ts`.
 *
 * The helper pushes per-field `ValidationError`s into the supplied
 * `errors` accumulator and returns a typed `ReplayOfReference` on
 * success, or `undefined` if any error was pushed.
 *
 * Validation rules:
 *   - Non-object root → wrong-type
 *   - Non-object `taskRef` → wrong-type
 *   - Missing/empty `taskRef.namespace` → missing or invalid-name (RFC1123)
 *   - Missing/empty `taskRef.name` → missing or invalid-name (RFC1123)
 *   - `taskRef.uid` present and non-UUID → invalid-name
 *   - `reason` present: non-string → wrong-type; >256 bytes UTF-8 → too-long;
 *     contains CR or LF → invalid-name
 *
 * See RESEARCH §12.2 for the reference implementation sketch.
 */
export function validateReplayOf(
  raw: unknown,
  errors: ValidationError[],
): ReplayOfReference | undefined {
  const startLen = errors.length;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'wrong-type', field: 'replayOf', expected: 'object' });
    return undefined;
  }

  const body = raw as Record<string, unknown>;

  // taskRef — required object
  const rawTaskRef = body.taskRef;
  if (rawTaskRef === null || typeof rawTaskRef !== 'object' || Array.isArray(rawTaskRef)) {
    errors.push({ code: 'wrong-type', field: 'replayOf.taskRef', expected: 'object' });
    return undefined;
  }

  const taskRef = rawTaskRef as Record<string, unknown>;

  // taskRef.namespace — required RFC1123 label
  const rawNamespace = taskRef.namespace;
  if (rawNamespace === undefined || rawNamespace === null) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.namespace' });
  } else if (typeof rawNamespace !== 'string' || rawNamespace.length === 0) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.namespace' });
  } else if (!K8S_NAMESPACE_RE.test(rawNamespace)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.namespace' });
  }

  // taskRef.name — required RFC1123 label
  const rawName = taskRef.name;
  if (rawName === undefined || rawName === null) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.name' });
  } else if (typeof rawName !== 'string' || rawName.length === 0) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.name' });
  } else if (!K8S_NAME_RE.test(rawName)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.name' });
  }

  // taskRef.uid — optional; when present must be UUID-shaped
  const rawUid = taskRef.uid;
  if (rawUid !== undefined && rawUid !== null) {
    if (typeof rawUid !== 'string' || !UUID_RE.test(rawUid)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.uid' });
    }
  }

  // reason — optional; when present: string, ≤256 bytes, no newlines
  const rawReason = body.reason;
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') {
      errors.push({ code: 'wrong-type', field: 'replayOf.reason', expected: 'string' });
    } else if (Buffer.byteLength(rawReason, 'utf8') > MAX_REPLAY_REASON_BYTES) {
      errors.push({ code: 'too-long', field: 'replayOf.reason', max: MAX_REPLAY_REASON_BYTES });
    } else if (/[\r\n]/.test(rawReason)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.reason' });
    }
  }

  // Return undefined if any error was pushed during this call.
  if (errors.length > startLen) return undefined;

  return {
    taskRef: {
      namespace: rawNamespace as string,
      name: rawName as string,
      ...(rawUid !== undefined && rawUid !== null && { uid: rawUid as string }),
    },
    ...(rawReason !== undefined &&
      rawReason !== null &&
      typeof rawReason === 'string' && { reason: rawReason }),
  };
}
