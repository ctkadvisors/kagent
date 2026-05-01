/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-M — pure logic for materializing an `Agent` CR from an
 * `AgentTemplate` + caller-supplied parameter values.
 *
 * Design fully specified in docs/AGENT-TEMPLATES.md (esp. §3 contract,
 * §4 naming + hash strategy, §6 security guardrails). This module
 * carries the math + render + validation; the K8s create call lives
 * in `template-server.ts` so the same instantiator can be unit-tested
 * without a live API.
 */

import { createHash } from 'node:crypto';

import { API_GROUP_VERSION } from './crds/types.js';
import type { AgentTemplate, AgentTemplateParameter, AgentTemplateSpec } from './crds/types.js';

export type InstantiateErrorCode =
  | 'parameter_unknown'
  | 'parameter_missing'
  | 'parameter_invalid'
  | 'template_not_found'
  | 'budget_exceeded'
  | 'rbac_denied'
  | 'cap_exhausted';

export class InstantiateError extends Error {
  readonly code: InstantiateErrorCode;
  constructor(code: InstantiateErrorCode, message: string) {
    super(message);
    this.name = 'InstantiateError';
    this.code = code;
  }
}

export interface InstantiateInput {
  readonly templateName: string;
  readonly parameterValues: Readonly<Record<string, string>>;
  readonly instanceName?: string;
  readonly createdByTaskUid: string;
  readonly clock?: () => Date;
}

/**
 * Manifest the materializer hands to K8s `create` for the new Agent.
 * Distinct from the runtime Agent type so the materializer doesn't
 * have to import server-only types here.
 */
export interface MaterializedAgentManifest {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Agent';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly annotations: Readonly<Record<string, string>>;
    readonly labels: Readonly<Record<string, string>>;
    readonly ownerReferences: ReadonlyArray<{
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
      readonly uid: string;
      readonly controller: boolean;
      readonly blockOwnerDeletion: boolean;
    }>;
  };
  readonly spec: Readonly<Record<string, unknown>>;
}

export interface InstantiateResult {
  readonly manifest: MaterializedAgentManifest;
  /** SHA256-derived deterministic agent name. Same input → same name. */
  readonly agentName: string;
  /** First-8-of-base32(sha256(canonicalJson(merged-params))). */
  readonly parameterHash: string;
  /** templateName@version — surfaces the version baked into the run. */
  readonly templateRef: string;
  /** Tools dropped because they weren't on the toolAllowlist. */
  readonly droppedTools: readonly string[];
  /** Final agent name's parent (the AgentTask UID that created it). */
  readonly createdByTaskUid: string;
}

/**
 * Render an `Agent` manifest from a template + parameter values.
 *
 * Validation pass (any failure → `InstantiateError`):
 *   1. Every key in `parameterValues` is declared in `template.spec.parameters`.
 *   2. Every required parameter has a value (caller-supplied OR default).
 *   3. Each value passes its parameter's `type` + `pattern` + `allowedValues` rules.
 *   4. Per-value byte cap (256) and per-call key cap (32) — substrate DoS guard.
 *
 * Render pass:
 *   - parameterHash = base32(sha256(canonicalJson({...defaults, ...values})))[0..7]
 *   - agentName = `${templateName}-${slug(instanceName ?? hash)}-${hash}`
 *   - agentSpec = mustache-without-helpers substitution of `${param.X}`
 *     into every string leaf of the template's `spec.agentSpec`. Non-string
 *     leaves pass through verbatim (numbers, booleans, nested objects).
 *   - For toolSelection params: intersect with toolAllowlist, drop the rest;
 *     write the result to `agentSpec.tools`.
 *   - Audit annotations per AGENT-TEMPLATES.md §6(d): template-ref,
 *     parameter-hash, created-by-task, created-at, budget-hash.
 */
export function buildAgentManifest(
  template: AgentTemplate,
  input: InstantiateInput,
): InstantiateResult {
  const namespace = template.metadata.namespace ?? 'default';
  const templateName = template.metadata.name ?? input.templateName;
  const params = template.spec.parameters ?? [];
  const declared = new Map<string, AgentTemplateParameter>(params.map((p) => [p.name, p]));

  // Per-call key cap (DoS guard).
  const supplied = Object.keys(input.parameterValues);
  if (supplied.length > 32) {
    throw new InstantiateError(
      'parameter_invalid',
      `parameterValues has ${String(supplied.length)} keys, exceeding 32-key cap`,
    );
  }

  // Validate caller-supplied values.
  for (const key of supplied) {
    if (!declared.has(key)) {
      throw new InstantiateError(
        'parameter_unknown',
        `parameter "${key}" is not declared in template "${templateName}"`,
      );
    }
    const value = input.parameterValues[key];
    if (typeof value !== 'string') {
      throw new InstantiateError('parameter_invalid', `parameter "${key}" must be a string`);
    }
    if (value.length > 256) {
      throw new InstantiateError(
        'parameter_invalid',
        `parameter "${key}" exceeds 256-char cap (got ${String(value.length)})`,
      );
    }
    const param = declared.get(key);
    if (param === undefined) continue;
    validateParameterValue(param, value);
  }

  // Required-parameter check + default merging.
  const merged: Record<string, string> = {};
  for (const param of params) {
    const supplied = input.parameterValues[param.name];
    if (supplied !== undefined) {
      merged[param.name] = supplied;
      continue;
    }
    if (param.default !== undefined) {
      merged[param.name] = param.default;
      continue;
    }
    if (param.required ?? true) {
      throw new InstantiateError(
        'parameter_missing',
        `parameter "${param.name}" is required by template "${templateName}"`,
      );
    }
  }

  // Hash the FULL merged map (defaults included) so adding a default
  // later doesn't silently change the hash for a caller who never set
  // the parameter.
  const parameterHash = computeParameterHash(merged);

  // Name: prefer caller's instanceName for the human-readable middle,
  // else use the hash twice. Hash always suffixes — that's the
  // deduplication identity.
  const middle = sanitizeNameFragment(input.instanceName ?? parameterHash);
  const agentName = buildAgentName(templateName, middle, parameterHash);

  // Resolve tools: caller-supplied toolSelection params are intersected
  // with toolAllowlist; missing params fall back to toolDefaults
  // (already a subset of toolAllowlist by template-author contract).
  const { tools, droppedTools } = resolveTools(template.spec, merged, declared);

  // Render the template body.
  const rendered = renderAgentSpec(template.spec.agentSpec, merged);
  const renderedSpec: Record<string, unknown> =
    rendered !== null && typeof rendered === 'object' && !Array.isArray(rendered)
      ? (rendered as Record<string, unknown>)
      : {};
  // Materialized Agent spec is the rendered template body, with the
  // resolved tools list overriding any tools field the template body
  // happened to set (template-author intent: the tool list is
  // structurally controlled by toolAllowlist, not a free-form spec
  // field).
  const finalSpec: Record<string, unknown> = {
    ...renderedSpec,
    ...(tools.length > 0 && { tools }),
  };

  const templateVersion = template.spec.templateVersion ?? 1;
  const templateRef = `${templateName}@v${String(templateVersion)}`;
  const budgetHash = computeBudgetHash(template.spec.budget);
  const now = (input.clock ?? (() => new Date()))();

  const annotations: Record<string, string> = {
    'kagent.knuteson.io/template-ref': templateRef,
    'kagent.knuteson.io/parameter-hash': parameterHash,
    'kagent.knuteson.io/created-by-task': input.createdByTaskUid,
    'kagent.knuteson.io/created-at': now.toISOString(),
    'kagent.knuteson.io/budget-hash': budgetHash,
    'kagent.knuteson.io/last-used-at': now.toISOString(),
  };

  const labels: Record<string, string> = {
    'kagent.knuteson.io/managed-by': 'kagent-operator',
    'kagent.knuteson.io/from-template': templateName,
    'app.kubernetes.io/created-by': 'kagent-operator',
  };

  return {
    manifest: {
      apiVersion: API_GROUP_VERSION,
      kind: 'Agent',
      metadata: {
        name: agentName,
        namespace,
        annotations,
        labels,
        // OwnerRef → the FIRST AgentTask that materialized this Agent.
        // Subsequent reuse calls do NOT add ownerRefs (that would couple
        // unrelated tasks via blockOwnerDeletion); we track concurrent
        // users via lastUsedAt + the GC sweeper instead.
        ownerReferences: [
          {
            apiVersion: API_GROUP_VERSION,
            kind: 'AgentTask',
            name: input.createdByTaskUid,
            uid: input.createdByTaskUid,
            controller: false,
            blockOwnerDeletion: false,
          },
        ],
      },
      spec: finalSpec,
    },
    agentName,
    parameterHash,
    templateRef,
    droppedTools,
    createdByTaskUid: input.createdByTaskUid,
  };
}

/* =====================================================================
 * Parameter validation
 * ===================================================================== */

function validateParameterValue(param: AgentTemplateParameter, value: string): void {
  switch (param.type) {
    case 'string':
      if (param.pattern !== undefined) {
        const re = compilePatternOrThrow(param);
        if (!re.test(value)) {
          throw new InstantiateError(
            'parameter_invalid',
            `parameter "${param.name}" value does not match pattern ${param.pattern}`,
          );
        }
      }
      if (param.allowedValues !== undefined && !param.allowedValues.includes(value)) {
        throw new InstantiateError(
          'parameter_invalid',
          `parameter "${param.name}" value not in allowedValues`,
        );
      }
      return;
    case 'integer': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || String(n) !== value) {
        throw new InstantiateError(
          'parameter_invalid',
          `parameter "${param.name}" must be an integer literal (got "${value}")`,
        );
      }
      if (param.allowedValues !== undefined && !param.allowedValues.includes(value)) {
        throw new InstantiateError(
          'parameter_invalid',
          `parameter "${param.name}" value not in allowedValues`,
        );
      }
      return;
    }
    case 'toolSelection': {
      // Wire shape: comma-separated tool names. Each name must look
      // like a valid identifier — refuse anything weird at the gate.
      const names = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const n of names) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(n)) {
          throw new InstantiateError(
            'parameter_invalid',
            `parameter "${param.name}" tool name "${n}" is not a valid identifier`,
          );
        }
      }
      return;
    }
  }
}

function compilePatternOrThrow(param: AgentTemplateParameter): RegExp {
  if (param.pattern === undefined) {
    throw new InstantiateError(
      'parameter_invalid',
      `parameter "${param.name}" pattern is undefined`,
    );
  }
  try {
    return new RegExp(param.pattern);
  } catch {
    throw new InstantiateError(
      'parameter_invalid',
      `parameter "${param.name}" pattern is not a valid regex: ${param.pattern}`,
    );
  }
}

/* =====================================================================
 * Tool resolution
 * ===================================================================== */

function resolveTools(
  spec: AgentTemplateSpec,
  merged: Readonly<Record<string, string>>,
  declared: ReadonlyMap<string, AgentTemplateParameter>,
): { tools: readonly string[]; droppedTools: readonly string[] } {
  const allow = new Set<string>(spec.toolAllowlist ?? []);

  // Find a toolSelection-typed parameter (only one supported in v0.1).
  let requested: readonly string[] | undefined;
  for (const [, p] of declared) {
    if (p.type !== 'toolSelection') continue;
    const value = merged[p.name];
    if (value === undefined || value.length === 0) continue;
    requested = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    break;
  }

  // Fall back to toolDefaults when no selection parameter or empty.
  const candidates = requested ?? spec.toolDefaults ?? [];
  const tools: string[] = [];
  const droppedTools: string[] = [];
  for (const t of candidates) {
    if (allow.has(t)) tools.push(t);
    else droppedTools.push(t);
  }
  return { tools, droppedTools };
}

/* =====================================================================
 * Render — mustache-without-helpers
 * ===================================================================== */

const PARAM_RE = /\$\{param\.([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Recursively walk `value`, replacing `${param.X}` substrings in every
 * string leaf with `params[X]`. Non-string leaves pass through. Unknown
 * parameter references LEAVE the literal in place (no silent dropping)
 * so a typo in the template surfaces in the rendered Agent and an
 * operator can spot it via `kubectl get agent -o yaml`.
 */
export function renderAgentSpec(value: unknown, params: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(PARAM_RE, (match, key: string) => {
      const v = params[key];
      return v === undefined ? match : v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderAgentSpec(v, params));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderAgentSpec(v, params);
    }
    return out;
  }
  return value;
}

/* =====================================================================
 * Naming + hashing
 * ===================================================================== */

const BASE32_ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Compute the parameterHash from the merged-with-defaults parameter map.
 * Canonicalized via lexicographic key order so map insertion order
 * doesn't change the hash.
 */
export function computeParameterHash(merged: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(merged)
    .sort()
    .reduce<Record<string, string>>((acc, k) => {
      const v = merged[k];
      if (v !== undefined) acc[k] = v;
      return acc;
    }, {});
  const json = JSON.stringify(sorted);
  const hash = createHash('sha256').update(json).digest();
  return base32EncodeFirst8(hash);
}

/** Compute a stable hash of the budget block — embedded as an annotation. */
export function computeBudgetHash(budget: AgentTemplateSpec['budget'] | undefined): string {
  const json = JSON.stringify(budget ?? {});
  const hash = createHash('sha256').update(json).digest();
  return base32EncodeFirst8(hash);
}

function base32EncodeFirst8(buf: Buffer): string {
  // Take 5 bytes (40 bits) → 8 base32 chars. Crockford-ish alphabet
  // (RFC 4648 lowercased). We only need 8 chars for collision-uniqueness
  // within a template's revisionHistoryLimit (≤1000 by CRD cap).
  let out = '';
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < 5; i++) {
    buffer = (buffer << 8) | (buf[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      const idx = (buffer >> (bits - 5)) & 0x1f;
      bits -= 5;
      out += BASE32_ALPHA[idx];
    }
  }
  return out.slice(0, 8);
}

/**
 * Sanitize a free-form fragment so the assembled agentName fits the K8s
 * RFC 1123 label rules (lowercase alphanumerics + dashes; ≤63 chars when
 * combined with the prefix + suffix).
 */
export function sanitizeNameFragment(fragment: string): string {
  const lowered = fragment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  // Trim leading/trailing dashes.
  const trimmed = lowered.replace(/^-+|-+$/g, '');
  // Cap length so the assembled name stays under the K8s 253 limit even
  // for long template names; 40 chars leaves comfortable room.
  return trimmed.slice(0, 40);
}

export function buildAgentName(
  templateName: string,
  middle: string,
  parameterHash: string,
): string {
  // Cap the templateName prefix so the assembled name comfortably fits
  // the 253-char K8s label limit (templateName + middle + hash + 2 dashes).
  const prefix = templateName.length > 100 ? templateName.slice(0, 100) : templateName;
  return `${prefix}-${middle}-${parameterHash}`;
}
