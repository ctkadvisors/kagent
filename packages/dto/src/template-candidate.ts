/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * template-candidate — Phase 4 / REV-02.
 *
 * Parser and shape-validator for the `application/x-kagent-template-candidate+yaml`
 * artifact payload. The accept handler in `routes/review-queue.ts` runs this
 * parser BEFORE creating the AgentTemplate CR, so a malformed or invalid
 * candidate is rejected at the API layer with a 422 rather than failing
 * inside the K8s API server.
 *
 * Design constraints:
 *   - Uses the existing `yaml` workspace dep (same as `disposition-parser.ts`).
 *     No new runtime dep on `@kagent/operator`.
 *   - `AgentTemplateSpec` is re-declared locally here (matches the type at
 *     `packages/operator/src/crds/types.ts:1103-1117`) to keep `@kagent/dto`
 *     a leaf workspace dep. When a shared `@kagent/crds` package emerges,
 *     both copies fold behind it. (LM-4 decision.)
 *   - Parser is fail-closed: every malformed input returns `{ ok: false, error }`
 *     rather than throwing, so the accept handler can respond 422 without
 *     try/catch wrapping every call.
 *
 * The YAML must conform to the AgentTemplateSpec shape at minimum:
 *   - `agentSpec`: object with `model` or `modelClass` (required)
 *   - `templateVersion`: number (optional; defaults to 1)
 *   - `parameters`: array of AgentTemplateParameter (optional)
 *   - `budget`: AgentTemplateBudget object (optional)
 *   - `toolAllowlist`: string array (optional)
 */

import { parse as parseYaml } from 'yaml';

/**
 * Parameter type discriminator. Mirror of `AgentTemplateParameterType`
 * in packages/operator/src/crds/types.ts — kept in sync manually until
 * a shared @kagent/crds package exists.
 */
export type AgentTemplateParameterType = 'string' | 'integer' | 'toolSelection';

const KNOWN_PARAMETER_TYPES: readonly string[] = ['string', 'integer', 'toolSelection'];
const PARAMETER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * A single named parameter slot for the template.
 * Mirror of `AgentTemplateParameter` in operator/src/crds/types.ts.
 */
export interface AgentTemplateParameter {
  readonly name: string;
  readonly type: AgentTemplateParameterType;
  readonly pattern?: string | undefined;
  readonly allowedValues?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
  readonly default?: string | undefined;
}

/**
 * Per-instance resource budget. All fields are optional — the operator
 * applies defaults when absent.
 * Mirror of `AgentTemplateBudget` in operator/src/crds/types.ts.
 */
export interface AgentTemplateBudget {
  readonly maxIterations?: number | undefined;
  readonly maxCostUsdPerRun?: number | undefined;
  readonly maxParallelInstances?: number | undefined;
}

/**
 * The declarative spec for a candidate AgentTemplate.
 * Mirror of `AgentTemplateSpec` in operator/src/crds/types.ts:1103-1117.
 * Kept in sync manually; see module JSDoc for the LM-4 rationale.
 *
 * Acceptance rule: `agentSpec` is the only required top-level field,
 * and it must declare `model` or `modelClass` so the template can
 * materialize into an Agent CR. All other fields are optional and
 * forwarded verbatim to the created AgentTemplate CR.
 */
export interface AgentTemplateSpec {
  readonly templateVersion?: number | undefined;
  readonly revisionHistoryLimit?: number | undefined;
  readonly idleTtlSeconds?: number | undefined;
  readonly parameters?: readonly AgentTemplateParameter[] | undefined;
  readonly budget?: AgentTemplateBudget | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly toolDefaults?: readonly string[] | undefined;
  /** Required: the agent body with ${param.X} placeholder substitution sites. */
  readonly agentSpec: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated result type for `parseAgentTemplateSpec`.
 * Callers match on `.ok` — never throw.
 */
export type ParseAgentTemplateSpecResult =
  | { readonly ok: true; readonly spec: AgentTemplateSpec }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a raw YAML string (the `application/x-kagent-template-candidate+yaml`
 * artifact payload) into a validated `AgentTemplateSpec`.
 *
 * Validation performed:
 *   1. YAML must parse without error (no malformed YAML).
 *   2. Root must be a non-null object (not an array, string, null, etc.).
 *   3. `agentSpec` field must be present, be a non-null object, and
 *      declare a non-empty `model` or `modelClass`.
 *   4. Numeric CRD-constrained fields must be integers inside their CRD ranges.
 *   5. `parameters` (when present) must be a non-empty array of objects,
 *      each with a CRD-valid `name` and `type` (one of the 3 known types).
 *   6. `budget` (when present) must be a non-null object.
 *   7. `toolAllowlist` (when present) must be an array of strings.
 *   8. `toolDefaults` (when present) must be an array of strings and, when
 *      a `toolAllowlist` exists, a subset of that allowlist.
 *
 * @param yaml - Raw YAML string from the artifact blob.
 * @returns `{ ok: true, spec }` on success; `{ ok: false, error }` on failure.
 */
export function parseAgentTemplateSpec(yaml: string): ParseAgentTemplateSpecResult {
  // --- Step 1: parse YAML
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `YAML parse error: ${message}` };
  }

  // --- Step 2: root must be a non-null object
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const kind = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    return {
      ok: false,
      error: `AgentTemplateSpec: root must be a non-null object, got ${kind}`,
    };
  }

  const doc = raw as Record<string, unknown>;

  // --- Step 3: agentSpec required
  if (!('agentSpec' in doc) || doc['agentSpec'] === undefined) {
    return { ok: false, error: 'AgentTemplateSpec: agentSpec is required' };
  }
  if (
    typeof doc['agentSpec'] !== 'object' ||
    doc['agentSpec'] === null ||
    Array.isArray(doc['agentSpec'])
  ) {
    return { ok: false, error: 'AgentTemplateSpec: agentSpec must be a non-null object' };
  }
  const agentSpec = doc['agentSpec'] as Record<string, unknown>;
  const hasModel = typeof agentSpec['model'] === 'string' && agentSpec['model'].trim() !== '';
  const hasModelClass =
    typeof agentSpec['modelClass'] === 'string' && agentSpec['modelClass'].trim() !== '';
  if (!hasModel && !hasModelClass) {
    return {
      ok: false,
      error: 'AgentTemplateSpec: agentSpec must declare model or modelClass',
    };
  }

  // --- Step 4: templateVersion (optional) — must be a positive integer when present
  if (doc['templateVersion'] !== undefined) {
    const tv = doc['templateVersion'];
    if (typeof tv !== 'number' || !Number.isInteger(tv) || tv < 1) {
      return {
        ok: false,
        error: `AgentTemplateSpec: templateVersion must be a positive integer, got ${typeof tv === 'number' ? tv.toString() : typeof tv}`,
      };
    }
  }

  const revisionHistoryLimitResult = integerInRange(
    doc['revisionHistoryLimit'],
    'revisionHistoryLimit',
    1,
    1000,
  );
  if (revisionHistoryLimitResult !== null) return revisionHistoryLimitResult;

  const idleTtlSecondsResult = integerInRange(doc['idleTtlSeconds'], 'idleTtlSeconds', 60, 86400);
  if (idleTtlSecondsResult !== null) return idleTtlSecondsResult;

  // --- Step 5: parameters (optional) — array of valid parameter objects
  if (doc['parameters'] !== undefined) {
    if (!Array.isArray(doc['parameters'])) {
      return { ok: false, error: 'AgentTemplateSpec: parameters must be an array' };
    }
    for (let i = 0; i < doc['parameters'].length; i++) {
      const p = doc['parameters'][i] as unknown;
      if (typeof p !== 'object' || p === null) {
        return { ok: false, error: `AgentTemplateSpec: parameters[${i}] must be an object` };
      }
      const param = p as Record<string, unknown>;
      if (typeof param['name'] !== 'string' || param['name'].trim() === '') {
        return {
          ok: false,
          error: `AgentTemplateSpec: parameters[${i}].name must be a non-empty string`,
        };
      }
      if (!PARAMETER_NAME_PATTERN.test(param['name'])) {
        return {
          ok: false,
          error: `AgentTemplateSpec: parameters[${i}].name must match pattern ${PARAMETER_NAME_PATTERN.source}`,
        };
      }
      const paramType = param['type'];
      if (typeof paramType !== 'string' || !KNOWN_PARAMETER_TYPES.includes(paramType)) {
        const rendered = typeof paramType === 'string' ? paramType : typeof paramType;
        return {
          ok: false,
          error: `AgentTemplateSpec: parameters[${i}].type '${rendered}' is not one of ${KNOWN_PARAMETER_TYPES.join(', ')}`,
        };
      }
    }
  }

  // --- Step 6: budget (optional) — must be a non-null object
  if (doc['budget'] !== undefined) {
    if (
      typeof doc['budget'] !== 'object' ||
      doc['budget'] === null ||
      Array.isArray(doc['budget'])
    ) {
      return { ok: false, error: 'AgentTemplateSpec: budget must be a non-null object' };
    }
    const budget = doc['budget'] as Record<string, unknown>;
    const maxIterationsResult = integerInRange(
      budget['maxIterations'],
      'budget.maxIterations',
      1,
      1000,
    );
    if (maxIterationsResult !== null) return maxIterationsResult;

    if (
      budget['maxCostUsdPerRun'] !== undefined &&
      (typeof budget['maxCostUsdPerRun'] !== 'number' ||
        !Number.isFinite(budget['maxCostUsdPerRun']) ||
        budget['maxCostUsdPerRun'] < 0)
    ) {
      return {
        ok: false,
        error: 'AgentTemplateSpec: budget.maxCostUsdPerRun must be a non-negative finite number',
      };
    }
    const maxParallelInstancesResult = integerInRange(
      budget['maxParallelInstances'],
      'budget.maxParallelInstances',
      1,
      10000,
    );
    if (maxParallelInstancesResult !== null) return maxParallelInstancesResult;
  }

  // --- Step 7: toolAllowlist (optional) — array of strings
  if (doc['toolAllowlist'] !== undefined) {
    if (!Array.isArray(doc['toolAllowlist'])) {
      return { ok: false, error: 'AgentTemplateSpec: toolAllowlist must be an array' };
    }
    for (let i = 0; i < doc['toolAllowlist'].length; i++) {
      if (typeof doc['toolAllowlist'][i] !== 'string') {
        return {
          ok: false,
          error: `AgentTemplateSpec: toolAllowlist[${i}] must be a string`,
        };
      }
    }
  }

  // --- Step 8: toolDefaults (optional) — array of strings
  if (doc['toolDefaults'] !== undefined) {
    if (!Array.isArray(doc['toolDefaults'])) {
      return { ok: false, error: 'AgentTemplateSpec: toolDefaults must be an array' };
    }
    for (let i = 0; i < doc['toolDefaults'].length; i++) {
      if (typeof doc['toolDefaults'][i] !== 'string') {
        return {
          ok: false,
          error: `AgentTemplateSpec: toolDefaults[${i}] must be a string`,
        };
      }
    }
    if (Array.isArray(doc['toolAllowlist'])) {
      const allowlist = new Set(doc['toolAllowlist']);
      const missing = doc['toolDefaults'].filter((tool) => !allowlist.has(tool));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `AgentTemplateSpec: toolDefaults must be a subset of toolAllowlist; missing ${missing.join(', ')}`,
        };
      }
    }
  }

  // All checks passed — cast to AgentTemplateSpec (shape is structurally validated)
  const spec: AgentTemplateSpec = doc as unknown as AgentTemplateSpec;
  return { ok: true, spec };
}

function integerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): ParseAgentTemplateSpecResult | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    const rendered = typeof value === 'number' ? value.toString() : typeof value;
    return {
      ok: false,
      error: `AgentTemplateSpec: ${field} must be an integer in [${min.toString()}, ${max.toString()}], got ${rendered}`,
    };
  }
  return null;
}
