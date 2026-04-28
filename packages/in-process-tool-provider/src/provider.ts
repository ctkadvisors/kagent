/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `InProcessToolProvider` — `ToolProvider` impl that invokes plain JS
 * functions as tools without subprocess overhead. Test-friendly,
 * zero-I/O, usable in Vitest without spawning children.
 *
 * Handler return-type union (D-19):
 *   - `string`         → wrapped to `{ content: <str>, isError: false }`
 *   - `ContentBlock[]` → wrapped to `{ content: <blocks>, isError: false }`
 *   - `ToolResult`     → returned as-is (escape hatch for isError + metadata)
 *
 * Handler throws are CAUGHT and mapped to `ToolResult{isError:true}`
 * with truncated 5-frame stack (D-20) — NOT propagated. The error flows
 * back to the LLM as a `role: 'tool'` message per the kernel convention.
 *
 * Provider exports NO error subclass family (D-26) — handler throws are
 * not provider-level failures. Construction-time errors throw the kernel's
 * `InvalidConfigError` (programmer error, not runtime failure).
 *
 * `ctx.abortSignal` is plumbed to the handler via `ctx` (D-23) — handler
 * may read `signal.aborted` and self-terminate; provider does not enforce.
 *
 * **T-IP-02 mitigation:** tools held in `Map<string, def>` (not a plain
 * object) — no prototype-pollution surface for `__proto__`/`constructor`-shaped
 * tool names. `Map.get()` returns undefined for unknown names; provider
 * throws `InvalidConfigError` rather than silently dispatching to a polluted
 * prototype member.
 */

import type {
  ContentBlock,
  JSONSchema,
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import { InvalidConfigError } from '@kagent/agent-loop';

/**
 * Definition of a single in-process tool — D-19.
 *
 * `handler` may return `string`, `ContentBlock[]`, or full `ToolResult`
 * (sync or async); the provider normalizes the return-type union.
 */
export interface InProcessToolDefinition {
  /** Stable tool name; surfaces to the model + the registry's tool→provider map. */
  name: string;
  /** Human-readable purpose; surfaces to the model. */
  description: string;
  /** JSON Schema describing the args object passed to `handler`. Kernel does not validate. */
  inputSchema: JSONSchema;
  /**
   * Handler invoked by `executeTool()`. May be sync or async; provider awaits
   * unconditionally (D-22). `ctx.abortSignal` is passed through (D-23) — handler
   * may read `signal.aborted` and self-terminate. Throws are caught and mapped
   * to `ToolResult{isError:true}` (D-20) — NOT propagated.
   */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolInvocationContext,
  ) => InProcessToolReturn | Promise<InProcessToolReturn>;
  /** Optional A2A-style free-form tags (e.g., 'destructive', 'read-only'). */
  tags?: readonly string[];
}

/**
 * Permitted handler return types — D-19.
 *
 * - `string` → wrapped to `{ content: <str>, isError: false }` (90% of cases)
 * - `ContentBlock[]` → wrapped to `{ content: <blocks>, isError: false }` (multi-block, image, resource)
 * - `ToolResult` → returned as-is (escape hatch when handler needs to set `isError` or `metadata`)
 */
export type InProcessToolReturn = string | ContentBlock[] | ToolResult;

/** Constructor options — D-19. */
export interface InProcessToolProviderOptions {
  /** Stable provider id; defaults to 'in-process'. Override to disambiguate multiple instances. */
  id?: string;
  /** Tool definitions registered up-front; immutable after construction. */
  tools: InProcessToolDefinition[];
}

export class InProcessToolProvider implements ToolProvider {
  public readonly id: string;
  private readonly tools: Map<string, InProcessToolDefinition>;
  private readonly descriptors: ToolDescriptor[];

  constructor(opts: InProcessToolProviderOptions) {
    if (!opts.tools || !Array.isArray(opts.tools)) {
      throw new InvalidConfigError('tools', 'must be an array');
    }
    this.id = opts.id ?? 'in-process';
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
    this.descriptors = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.tags !== undefined && { tags: t.tags }),
    }));
  }

  describeTools(_ctx?: ToolInvocationContext): ToolDescriptor[] {
    // ctx is part of the WS-G interface change so subprocess providers
    // can cancel slow lookups; in-process enumeration is synchronous and
    // I/O-free, so the signal is intentionally unused here.
    return this.descriptors;
  }

  async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
    const def = this.tools.get(call.name);
    if (!def) {
      throw new InvalidConfigError('tool', `unknown tool "${call.name}"`);
    }
    const args = (call.args ?? {}) as Record<string, unknown>;
    try {
      const raw = await Promise.resolve(def.handler(args, ctx));
      return normalizeReturn(raw);
    } catch (err) {
      // D-20: handler throw → ToolResult{isError:true}, NOT thrown.
      const message = err instanceof Error ? err.message : String(err);
      const stack =
        err instanceof Error && err.stack
          ? err.stack.split('\n').slice(0, 5).join('\n')
          : undefined;
      const errorName = err instanceof Error ? err.constructor.name : typeof err;
      return {
        content: stack ? `${message}\n${stack}` : message,
        isError: true,
        metadata: { errorName },
      };
    }
  }
}

/**
 * Normalize the union return-type to `ToolResult`. Pure function; no side
 * effects; never throws (the wrapping is total over the InProcessToolReturn
 * union).
 */
function normalizeReturn(value: InProcessToolReturn): ToolResult {
  if (typeof value === 'string') return { content: value, isError: false };
  if (Array.isArray(value)) return { content: value, isError: false };
  return value;
}
