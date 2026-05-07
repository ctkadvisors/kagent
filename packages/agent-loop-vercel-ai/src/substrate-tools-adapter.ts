/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 2 — `KagentSubstrateToolsAdapter` (R3 §4.1).
 *
 * Re-emits the substrate's in-process tools — `spawn_child_task`,
 * `wait_for_*`, `publish_event`, `read_artifact`, `write_artifact`,
 * `get_my_context` — in Vercel AI SDK `tool({execute})` shape by
 * delegating to the existing `InProcessToolDefinition` factories from
 * `@kagent/agent-pod`. The adapter wraps each handler in a thin
 * `execute` shim that:
 *
 *   1. Coerces the raw input from JSON-Schema-shaped `unknown` to the
 *      handler's expected `args` shape (the existing handlers already
 *      validate via their JSON schema; the adapter trusts that).
 *   2. Provides the kagent `ToolInvocationContext` from the
 *      `ToolExecutionOptions` Vercel AI SDK passes (notably the
 *      AbortSignal so substrate tools can cancel mid-call when the
 *      streamText abort signal fires).
 *   3. Wraps the resulting tool with `wrapToolWithCapabilityCheck`
 *      (Component 6) when a `CapabilityBundle` is provided so the
 *      operator-minted JWT is verified before the tool fires.
 *
 * The adapter does NOT re-implement the tool guardrails (depth caps,
 * SSRF, capability narrowing, etc.) — those live inside the
 * `define*` factories from `@kagent/agent-pod` and run unchanged.
 * The adapter is a SHAPE bridge, not a policy bridge.
 *
 * Tools that the agent's spec doesn't admit are simply not registered;
 * the caller's `Agent.spec.tools` (passed via `opts.admittedToolNames`)
 * decides which substrate tools appear in the Vercel AI SDK tool set.
 */

import type {
  InProcessToolDefinition,
  InProcessToolReturn,
} from '@kagent/in-process-tool-provider';
import type { ToolInvocationContext } from '@kagent/agent-loop';
import type { CapabilityBundle } from '@kagent/capability-types';
import { tool, type Tool } from 'ai';
import { z } from 'zod';

import { wrapToolWithCapabilityCheck, type CapabilityCategory } from './capability-tool-wrapper.js';

/**
 * Per-tool capability binding — names the
 * `CapabilityClaims.<category>` slot the wrapper should check, plus a
 * deriver that pulls the gated value out of the tool's input. The
 * runner provides one entry per substrate tool; tools without a
 * binding skip the cap wrapper (universal tools like
 * `get_my_context`).
 */
export interface SubstrateToolCapabilityBinding {
  readonly category: CapabilityCategory;
  readonly target: string | ((input: Record<string, unknown>) => string | undefined);
}

export interface SubstrateToolsAdapterOpts {
  /**
   * The kagent `InProcessToolDefinition`s the runner has already built
   * (typically the result of `defineSpawnChildTask` /
   * `definePublishEvent` / `defineGetMyContext` etc. from
   * `@kagent/agent-pod`). The adapter delegates to these handlers
   * verbatim — the substrate's existing guardrails fire unchanged.
   */
  readonly definitions: readonly InProcessToolDefinition[];
  /**
   * Optional whitelist — when provided, only definitions whose `name`
   * appears here are emitted. Mirrors the runner's `Agent.spec.tools`
   * gate. When undefined, every definition is emitted.
   */
  readonly admittedToolNames?: readonly string[];
  /**
   * Per-tool capability bindings. The adapter looks each definition's
   * name up here; an entry causes the emitted tool to be wrapped with
   * `wrapToolWithCapabilityCheck`. Definitions without an entry are
   * emitted without the outer cap gate (matches the runner's
   * existing pattern where `get_my_context` is universal but
   * `spawn_child_task` is gated).
   */
  readonly capabilityBindings?: Readonly<Record<string, SubstrateToolCapabilityBinding>>;
  /**
   * Optional verified bundle — passed verbatim into
   * `wrapToolWithCapabilityCheck`. Undefined = legacy mode (no cap
   * mounted); the wrapper falls through to the inner tool's own
   * legacy gate.
   */
  readonly capabilityBundle?: CapabilityBundle;
  /**
   * Run id stamped onto every `ToolInvocationContext` the adapter
   * synthesizes. Required so the substrate tools' tracing has a
   * stable correlation id.
   */
  readonly runId: string;
}

/**
 * Output of the adapter — a Vercel AI SDK `ToolSet`-compatible map
 * keyed by tool name. Caller passes this directly to
 * `streamText({ tools })`.
 */
export interface SubstrateToolBundle {
  readonly tools: Readonly<Record<string, Tool<unknown, unknown>>>;
  readonly toolNames: readonly string[];
}

/**
 * Build the Vercel-AI-SDK-shaped tool bundle from the kagent
 * `InProcessToolDefinition`s the runner has already constructed.
 *
 * Implementation note on schemas: the existing handlers carry a
 * JSON-Schema-shaped `inputSchema`. Vercel AI SDK's `tool()` accepts
 * a `FlexibleSchema<INPUT>` which can be a Zod schema OR a
 * pre-built schema-like object. The adapter takes the JSON schema
 * verbatim; the SDK accepts JSON-Schema-shaped objects via its
 * `jsonSchema()` helper (we rely on the same import indirectly via
 * `ai`'s `tool()` call wiring). To avoid coupling to that helper —
 * which has shifted import paths between SDK versions — we ship a
 * permissive `z.unknown()` schema and rely on the inner handler's
 * validation. This keeps the adapter version-flexible across
 * AI SDK 6.x patches; integrators who want first-class param
 * validation can swap the schema per tool by post-processing the
 * returned bundle.
 */
export function buildSubstrateTools(opts: SubstrateToolsAdapterOpts): SubstrateToolBundle {
  const admit = opts.admittedToolNames !== undefined ? new Set(opts.admittedToolNames) : undefined;
  const bindings = opts.capabilityBindings ?? {};
  const out: Record<string, Tool<unknown, unknown>> = {};
  const names: string[] = [];
  for (const def of opts.definitions) {
    if (admit !== undefined && !admit.has(def.name)) continue;
    const t = adaptOne(def, opts.runId);
    const binding = bindings[def.name];
    const final = binding
      ? wrapToolWithCapabilityCheck<unknown, unknown>(t, {
          bundle: opts.capabilityBundle,
          category: binding.category,
          target:
            typeof binding.target === 'function'
              ? (input) => {
                  // The deriver expects a record-shaped input. We
                  // narrow defensively — non-object inputs trigger
                  // the inner handler's own validation.
                  const rec = input as Record<string, unknown> | null;
                  if (rec === null || typeof rec !== 'object') return undefined;
                  return binding.target instanceof Function ? binding.target(rec) : undefined;
                }
              : binding.target,
          requireBundle: opts.capabilityBundle !== undefined,
        })
      : t;
    out[def.name] = final;
    names.push(def.name);
  }
  return { tools: out, toolNames: names };
}

/**
 * Adapt one `InProcessToolDefinition` into a Vercel AI SDK `Tool`.
 * The execute shim builds a `ToolInvocationContext` from the
 * `ToolExecutionOptions` Vercel AI SDK supplies (notably
 * `abortSignal` — substrate tools that watch this signal will
 * cancel cleanly when streamText is aborted) and forwards the input
 * to the kagent handler.
 *
 * The handler's return — `string | ContentBlock[] | ToolResult` —
 * is normalized to a JSON-stringified shape Vercel AI SDK can carry
 * back as the tool result. The agent-pod runner already follows the
 * same JSON-stringification convention when `executor.ts` records
 * tool outputs, so the trace shape stays uniform.
 */
function adaptOne(def: InProcessToolDefinition, runId: string): Tool<unknown, unknown> {
  return tool({
    description: def.description,
    // Permissive schema — the handler already validates via its own
    // JSON-Schema gate (or its own structural checks). Tightening
    // this is a per-tool follow-up; ships permissive so the adapter
    // is uniform across SDK minor versions.
    inputSchema: z.unknown(),
    execute: async (input, callOptions): Promise<unknown> => {
      const args = coerceArgs(input);
      const ctx: ToolInvocationContext = {
        runId,
        abortSignal: callOptions.abortSignal ?? new AbortController().signal,
      };
      const raw: InProcessToolReturn = await Promise.resolve(def.handler(args, ctx));
      return normalizeReturnForVercelAi(raw);
    },
  });
}

function coerceArgs(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input === 'object') return input as Record<string, unknown>;
  // The model occasionally emits a JSON-stringified input (especially
  // for some Workers AI shapes). Try to parse; fall back to wrapping
  // so the inner schema's `additionalProperties: false` either
  // accepts or refuses the result with its own error.
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return { value: input };
}

/**
 * Normalize the kagent handler return type union to a value Vercel AI
 * SDK serializes cleanly into the tool-result message. Mirrors the
 * `stringifyToolContent` helper in `@kagent/agent-loop/executor.ts`
 * — strings pass through; structured content (ContentBlock[] or
 * ToolResult) is JSON-stringified into the same shape the kagent
 * trace already records.
 */
function normalizeReturnForVercelAi(raw: InProcessToolReturn): unknown {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    // ContentBlock[] — return the structured array; AI SDK wraps in
    // a tool-result message. Consumers that prefer a flat string can
    // post-process; the structured shape gives the tool's output the
    // same fidelity it would have under the kagent loop.
    return raw;
  }
  // ToolResult — surface the content + isError flag as a
  // discriminated object so the SDK's downstream serialization
  // preserves the failure signal. When `isError` is true, AI SDK
  // by convention treats the result as an error message back to the
  // model on the next turn.
  if (raw.isError) {
    // Throwing here would abort the AI SDK tool execution; the kagent
    // tool contract wants the message back to the model so it can
    // recover. Return a wrapper object the model sees as the tool
    // output payload.
    return { isError: true, content: raw.content };
  }
  return raw.content;
}
