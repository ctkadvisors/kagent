/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 — model-class resolver.
 *
 * Translates an Agent's `spec.model` / `spec.modelClass` pair into a
 * physical model id at AgentTask materialization time, given the
 * cluster's logical-class → physical-model map (chart-supplied via
 * Helm values; threaded through the operator from
 * `KAGENT_AGENT_MODEL_CLASSES_JSON`).
 *
 * Design contract — see `docs/MODEL-ROUTING.md` §3 for the full story.
 *
 * Precedence (top wins):
 *   1. `agentSpec.model` non-empty   → escape-hatch; emit `source: 'override'`.
 *   2. `agentSpec.modelClass` non-empty AND key has a non-empty mapping
 *      in `classMap` → emit `source: 'class'` with the resolved physical
 *      model id.
 *   3. `agentSpec.modelClass` non-empty but key missing OR maps to an
 *      empty/whitespace string → `unresolvable` (caller raises a
 *      structured error visible on AgentTask `status.error`).
 *   4. Neither set → `unresolvable` (defense-in-depth; the CRD admission
 *      validator should have rejected this earlier).
 *
 * Whitespace-only strings are treated as empty.
 *
 * The resolver is pure-functional: no I/O, no mutation, no logging.
 * The caller (`job-spec.ts`) is responsible for emitting the
 * `[operator/job-spec] resolved modelClass=...` audit log line on
 * `source: 'class'` results.
 */

/**
 * v0.1.9 context-awareness — per-class entry shape.
 *
 * `model` is the physical model id the LLM gateway resolves
 * (`workers-ai/@cf/...`, `ollama/...`); `contextWindowTokens` is the
 * model's documented context window in tokens. When present, the
 * operator projects it onto every spawned agent-pod as
 * `KAGENT_AGENT_MODEL_CONTEXT_WINDOW=<integer>` so the in-pod agent-loop
 * can compute utilization (Piece 2), enforce a substrate-side
 * safety-net at 95% (Piece 3), and the detector battery can flag
 * `context_pressure_ignored` at 70% (Piece 4). When omitted, all three
 * downstream pieces degrade to no-op per docs/CONTEXT-AWARENESS.md §7.
 *
 * Shape kept open-ended (no `readonly` on the inner field set) so a
 * future `priceTier`/`maxOutputTokens`/etc. addition is one-line.
 */
export interface ModelClassEntry {
  readonly model: string;
  readonly contextWindowTokens?: number;
}

/**
 * Cluster-supplied logical-class → entry mapping. Empty map (`{}`) is
 * the chart default — the homelab overlay supplies the actual entries.
 * Read-only at this layer; the operator parses it once at boot and
 * threads the same reference through every reconcile.
 *
 * v0.1.9 context-awareness: entries widened from a bare physical-model
 * string to a structured {@link ModelClassEntry} so the resolver can
 * surface `contextWindowTokens` alongside the model. The Helm chart's
 * deployment.yaml `toJson` projection of `agent.modelClasses` preserves
 * the YAML object shape unchanged. The pre-v0.1.9 wire-format
 * (entries as bare strings) is normalized to `{ model: <string> }` by
 * `parseModelClassesEnv` in main.ts so chart values authored against
 * the old shape continue to work.
 */
export type ModelClassMap = Readonly<Record<string, ModelClassEntry>>;

/**
 * Inputs to {@link resolveAgentModel}. The agent spec is narrowed to
 * just the two fields the resolver consults so unit tests can pass a
 * minimal literal without having to fabricate a full `AgentSpec`.
 */
export interface ResolveModelInput {
  readonly agentSpec: {
    readonly model?: string;
    readonly modelClass?: string;
  };
  readonly classMap: ModelClassMap;
}

/**
 * Result of {@link resolveAgentModel}. Discriminated union so the call
 * site exhaustively handles the unresolvable case rather than reading
 * a possibly-empty string back.
 *
 * On `kind: 'resolved'`, `source` distinguishes the escape-hatch
 * (`'override'` — a literal `spec.model`) from the substrate-routed
 * path (`'class'` — `spec.modelClass` resolved through `classMap`).
 *
 * On `kind: 'unresolvable'`, `reason` is human-readable for the
 * AgentTask `status.error` surface; `modelClass` carries the offending
 * class string when one was set, so callers can include it in
 * structured audit fields without re-reading the input.
 */
export type ResolveModelResult =
  | {
      readonly kind: 'resolved';
      readonly model: string;
      readonly source: 'override' | 'class';
      /**
       * v0.1.9 context-awareness — surfaced for `source: 'class'` results
       * when the matched {@link ModelClassEntry} declares
       * `contextWindowTokens`. The override path (`source: 'override'`,
       * literal `spec.model`) leaves this `undefined` — the chart map
       * is the single source of truth for context windows; per-Agent
       * windows are explicitly out of scope per
       * docs/CONTEXT-AWARENESS.md §9 Q5.
       */
      readonly contextWindowTokens?: number;
    }
  | { readonly kind: 'unresolvable'; readonly reason: string; readonly modelClass?: string };

/**
 * Treat empty + whitespace-only strings as absent. The CRD admission
 * validator already rejects empty `modelClass` strings, but the
 * resolver mirrors that semantic for `model` too — `model: ''` is
 * the YAML form most CRD writers end up with when explicitly clearing
 * an override, and the resolver MUST fall through to `modelClass` in
 * that case (see `docs/MODEL-ROUTING.md` §3.1).
 */
function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve an Agent's effective physical model id given the cluster's
 * class map. See module-level docstring for the full precedence chain.
 *
 * Pure-functional: never throws, never mutates inputs. Callers handle
 * the `unresolvable` outcome by surfacing a domain error onto the
 * AgentTask's terminal `status.error`.
 */
export function resolveAgentModel(input: ResolveModelInput): ResolveModelResult {
  const { agentSpec, classMap } = input;

  // 1. spec.model wins (escape-hatch). Empty / whitespace falls through.
  if (isPresent(agentSpec.model)) {
    return { kind: 'resolved', model: agentSpec.model, source: 'override' };
  }

  // 2. spec.modelClass → classMap lookup.
  if (isPresent(agentSpec.modelClass)) {
    const className = agentSpec.modelClass;
    const entry: ModelClassEntry | undefined = classMap[className];
    if (entry !== undefined && isPresent(entry.model)) {
      // v0.1.9 — surface contextWindowTokens when the entry declares
      // it (positive integer). Negative / zero / non-integer values
      // are dropped at parseModelClassesEnv time, so any value that
      // reaches here is already validated.
      return {
        kind: 'resolved',
        model: entry.model,
        source: 'class',
        ...(typeof entry.contextWindowTokens === 'number' && {
          contextWindowTokens: entry.contextWindowTokens,
        }),
      };
    }
    // 3. modelClass set but missing / empty in the cluster config.
    return {
      kind: 'unresolvable',
      reason: `modelClass "${className}" not in cluster config`,
      modelClass: className,
    };
  }

  // 4. Neither set (defense-in-depth — admission should have caught it).
  return {
    kind: 'unresolvable',
    reason: 'neither model nor modelClass set',
  };
}

/**
 * Apply the resolved physical model id back onto an Agent spec.
 *
 * Returns a NEW spec object with `model` populated from the resolution
 * result, leaving every other field (including `modelClass` for
 * traceability) untouched. The caller is responsible for passing only
 * `'resolved'` (non-unresolvable) results — passing an empty string
 * here would defeat the whole reason this helper exists, but the
 * function does not validate (callers always have an upstream
 * resolution they're propagating).
 *
 * Generic over `T` so the helper works with both the full
 * `AgentSpec` type and any narrower structural variant the operator
 * holds at the call site (e.g. the Phase 2 `buildJobSpec` resolver
 * passes only the two fields it consults). Excess fields on `T` are
 * preserved verbatim; only `model` is overwritten.
 *
 * Pure-functional: never throws (modulo a runtime error if the input
 * isn't an object — TypeScript's structural typing guards against
 * that), never mutates the input.
 *
 * Fix v0.1.8-modelclass.1: Phase 2 only populated the resolved model
 * onto the `KAGENT_AGENT_MODEL` env var, NOT onto `agent.spec.json`
 * mounted via the per-Job ConfigMap. The agent-pod's `parseEnv` reads
 * the JSON and bails on `model: undefined` for migrated CRs that
 * declare `modelClass` only. This helper is the operator-side
 * rewrite that closes that gap — see `job-spec.ts` callers.
 */
export function applyResolvedModel<T extends { model?: string; modelClass?: string }>(
  spec: T,
  resolvedModel: string,
): T {
  return { ...spec, model: resolvedModel };
}
