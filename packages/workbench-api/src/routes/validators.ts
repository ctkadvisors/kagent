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

import type { CreateTaskRequest } from '../types-write.js';

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
  | { readonly code: 'invalid-name'; readonly field: string };

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly value?: CreateTaskRequest;
}

/** Per AgentTask CRD: originalUserMessage cap. */
const MAX_MESSAGE_BYTES = 32_768;

/** K8s name regex (RFC 1123 label subset; lowercase alphanumerics + dashes). */
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,251}[a-z0-9])?$/;

/** K8s namespace regex (same shape as label, max 63 chars). */
const K8S_NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

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

  // payload — opaque; allow any non-null object/value
  const payload = body.payload;

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
