/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 6 — Capability JWT enforcement wrapper (R3 §4.1).
 *
 * Per-tool `execute` wrapper that consults the parent's
 * `CapabilityBundle` (loaded by `cap-consumer.loadCapabilityOptional`)
 * before invoking the underlying tool implementation. Mirrors the
 * pattern in `definePublishEvent` / `defineSpawnChildTask` where each
 * substrate tool checks `bundle.claims.<category>` against the
 * tool's target before doing anything else, refusing with
 * `policy_denied:no_capability` (matching the existing taxonomy) when
 * the cap is missing.
 *
 * Defense-in-depth: the substrate-tool factories in `@kagent/agent-pod`
 * already enforce capability claims internally (verified in
 * `builtin-tools-spawn.ts:259-277`, `builtin-tools-publish.ts`, etc.).
 * This wrapper adds an outer cap check so a Vercel-AI-SDK adapter that
 * registers a custom tool (e.g. an HTTP-tool-provider re-emit) can
 * still gate execution on the verified bundle without each tool
 * re-implementing the check. When the inner tool ALSO has its own
 * cap check, both fire — the wrapper's check is shape-uniform across
 * the whole tool surface; the inner check is target-specific.
 *
 * Refusal taxonomy intentionally matches the substrate's existing
 * shape so per-trace observability rolls up across in-pod + admission
 * decisions.
 */

import type { CapabilityBundle } from '@kagent/capability-types';
import { globMatchAny } from '@kagent/capability-types';
import type { Tool, ToolExecuteFunction } from 'ai';

/**
 * Capability categories the wrapper can gate on. Matches the
 * `CapabilityClaims` keys in `@kagent/capability-types`. The
 * `tenant` category is special — it's a single string (not a
 * pattern list) — and therefore not a valid choice here; tools
 * that need tenant matching should use the dedicated
 * `bundleAdmits('tenant', target)` helper from `@kagent/agent-pod`
 * (`cap-consumer.ts:213-225`) directly.
 */
export type CapabilityCategory = 'tools' | 'spawn' | 'read' | 'write' | 'egress';

/**
 * Inputs to the wrapper. The `category` is the
 * `CapabilityClaims.<category>` list to check; `target` is the
 * resource identifier the tool will act on (tool name, agent name,
 * URI prefix, etc., depending on the category). The `target` may
 * be a pure string OR a function that derives the target from the
 * tool's input — useful when the gate value is in `args.uri` or
 * `args.agentName`.
 */
export interface CapabilityCheckOpts<INPUT> {
  readonly bundle: CapabilityBundle | undefined;
  readonly category: CapabilityCategory;
  /**
   * Static target string OR a derivation function. The function
   * receives the parsed tool input so callers can pull the gated
   * value out of nested args (e.g. `(args) => args.agentName`).
   * Returning `undefined` from the deriver SKIPS the check — useful
   * for tools whose target is optional in the schema.
   */
  readonly target: string | ((input: INPUT) => string | undefined);
  /**
   * When true (the default), missing bundle = refusal. When the
   * runner is in legacy mode (no cap mounted), pass `false` to skip
   * the wrapper's gate entirely so the inner tool's own legacy
   * fallback path runs unchanged. Mirrors the
   * `loadCapabilityOptional` mode 1 contract in `cap-consumer.ts`.
   */
  readonly requireBundle?: boolean;
}

/**
 * Wrap a Vercel AI SDK `Tool` so its `execute` function consults the
 * capability bundle BEFORE delegating to the original implementation.
 * Returns a NEW `Tool` (the input is not mutated). When the underlying
 * tool has no `execute` (a tool whose result is supplied separately),
 * the wrapper returns the input unchanged — there's nothing to gate.
 */
export function wrapToolWithCapabilityCheck<INPUT, OUTPUT>(
  tool: Tool<INPUT, OUTPUT>,
  opts: CapabilityCheckOpts<INPUT>,
): Tool<INPUT, OUTPUT> {
  const innerExecute = tool.execute;
  if (typeof innerExecute !== 'function') {
    return tool;
  }
  const requireBundle = opts.requireBundle ?? true;
  // The wrapped runner is `async` so its refusal manifests as a
  // rejected promise rather than a sync throw. The kagent agent-loop's
  // executor handles either shape, but Vercel AI SDK consumers
  // (`streamText` / `generateText`) expect tool failures to propagate
  // through the promise chain — making the function async lets `await`
  // / `.catch` / `expect().rejects` see the refusal uniformly.
  const wrappedExecute: ToolExecuteFunction<INPUT, OUTPUT> = async (
    input,
    callOptions,
  ): Promise<OUTPUT> => {
    const bundle = opts.bundle;
    if (bundle === undefined) {
      if (requireBundle) {
        throw new Error(
          `policy_denied:no_capability — tool requires a verified capability bundle (category=${opts.category}); set KAGENT_CAP_JWT_FILE or run with the legacy fallback`,
        );
      }
      // Legacy mode — no cap mounted; the inner tool handles its own
      // legacy gate (e.g. `allowedChildAgents` in spawn). Pass through.
      return (await innerExecute(input, callOptions)) as OUTPUT;
    }
    const target = typeof opts.target === 'function' ? opts.target(input) : opts.target;
    if (target === undefined) {
      // Caller said "skip" — let the inner tool fire.
      return (await innerExecute(input, callOptions)) as OUTPUT;
    }
    const patterns = bundle.claims[opts.category];
    const list = Array.isArray(patterns) ? (patterns as readonly string[]) : [];
    if (!globMatchAny(list, target)) {
      throw new Error(
        `policy_denied:capability_violation — target "${target}" is not admitted by cap.claims.${opts.category}=[${list.join(', ')}] (cap jti=${bundle.jti})`,
      );
    }
    return (await innerExecute(input, callOptions)) as OUTPUT;
  };
  // Spread original metadata; replace execute. Preserves
  // inputSchema / description / providerOptions / etc. that the
  // model needs at tool-call time.
  return { ...tool, execute: wrappedExecute } as Tool<INPUT, OUTPUT>;
}
