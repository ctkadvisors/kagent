/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Type declarations + thin federation helper for the vendor-agnostic
 * `ToolProvider` interface.
 *
 * Mixed module: 5 interface/type declarations are erased at emit (zero
 * runtime bytes), 1 class (`ToolProviderRegistry`) ships real bytes.
 *
 * MCP-aligned tool schema is FUTURE-PROTOCOL COMPATIBILITY, not MCP
 * adoption — The loop does NOT import any MCP package; `JSONSchema` is
 * a permissive `Record<string, unknown>` so providers and consumers own
 * schema correctness (RESEARCH §7 Pitfall 2 — backend APIs differ on JSON
 * Schema draft compatibility; MCP servers may emit either common draft).
 *
 * Provider stays TRACE-UNAWARE per D-09 — interface ships zero trace
 * members; executor wraps every `executeTool()` with timing. Provider
 * focuses on tool execution, executor owns observability.
 */

import type { ToolCall } from './llm-client.js';
import { DuplicateToolNameError } from './errors.js';

/**
 * Permissive JSON Schema alias — D-07.
 *
 * Kernel ships ZERO schema validation. The alias serves as documentation
 * and a `@see` anchor; runtime shape is whatever the provider hands over.
 * Backend model APIs differ on which JSON Schema draft they require (common
 * drafts in the wild: draft-07 and 2020-12); MCP servers may emit either.
 * Consumers ensure the schema is acceptable to their target backend.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * Optional structured content blocks for tool results — D-08.
 *
 * Aligns with MCP `tools/call` response shape. Most tools return a single
 * text block; binary / image / resource results use the structured form.
 */
export interface ContentBlock {
  /** Block type — currently 'text' | 'image' | 'resource'. */
  type: 'text' | 'image' | 'resource';
  /** Text content for `type: 'text'`. */
  text?: string;
  /** Base64-encoded payload for `type: 'image'`. */
  bytes?: string;
  /** MIME type for image/resource blocks. */
  mimeType?: string;
  /** URI for `type: 'resource'`. */
  uri?: string;
}

/**
 * MCP-aligned tool descriptor — D-07.
 *
 * `LLMClient` impls translate to provider-specific tool formats internally.
 * The loop does not bake a vendor-side concept into its surface.
 */
export interface ToolDescriptor {
  /** Stable tool name; resolves to a provider via `ToolProviderRegistry.providerFor`. */
  name: string;
  /** Human-readable tool purpose. Surfaces to the model as the tool's prompt-side description. */
  description: string;
  /**
   * JSON Schema for tool inputs. See https://modelcontextprotocol.io/specification.
   * Backend model APIs differ on which JSON Schema draft they accept (common
   * drafts in the wild: draft-07 and 2020-12); MCP servers may emit either.
   * Consumers responsible for ensuring schema is acceptable to their target
   * backend. Kernel passes through unmodified.
   */
  inputSchema: JSONSchema;
  /** Optional A2A-style free-form tags (e.g., 'destructive', 'idempotent', 'read-only'). */
  tags?: readonly string[];
}

/**
 * Result of `ToolProvider.executeTool()` — D-08.
 *
 * Matches MCP `tools/call` response shape. `isError` is the canonical
 * success/fail bit; tool errors flow back to the model as `role: 'tool'`
 * messages (NOT thrown). Throwing inside `executeTool()` is reserved for
 * programmer errors.
 */
export interface ToolResult {
  /** Either a flat string (most cases) or structured content blocks (MCP-aligned). */
  content: string | ContentBlock[];
  /** Canonical success/fail bit. Errors flow back to the model as tool messages with isError=true. */
  isError: boolean;
  /**
   * Provider-specific non-user-facing context (upstream latency, idempotency key, etc.).
   * Surfaces in the trace `metadata?` field but NOT in the chat history.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed to every `executeTool()` call — D-08 + D-29 + D-30.
 *
 * `abortSignal` is REQUIRED (not optional) — providers MUST propagate to
 * their underlying I/O (fetch, child_process.spawn, etc.).
 * `parentRunId` is the M2 delegation forward-compat slot; always undefined
 * in M1. The future M2 band injects an `authority?: AuthorityToken` field
 * here that providers gate on before dispatch.
 */
export interface ToolInvocationContext {
  /** Per-run correlation id; flows from executor's RunInput.runId through ClientContext. */
  runId: string;
  /** Cancellation handle owned by the consumer; propagates from RunInput.signal. */
  abortSignal: AbortSignal;
  /** Forward-compat slot (inert in M1; populated by M2 ctx.delegate primitive). */
  parentRunId?: string;
}

/**
 * Vendor-agnostic tool-execution provider.
 *
 * Each provider claims a stable `id` (kebab-case: 'http', 'mcp-stdio',
 * 'in-process'). The executor calls `describeTools()` once at construction
 * (and on demand) and routes `executeTool()` calls via the registry.
 *
 * Provider stays TRACE-UNAWARE — executor wraps every call with timing
 * and emits the trace entry. Provider focuses solely on tool execution.
 */
export interface ToolProvider {
  /** Stable provider id — kebab-case ('http', 'mcp-stdio', 'in-process'). Used by registry for attribution. */
  readonly id: string;
  /** Returns the tools this provider offers. Sync or async; called once at executor construction (and on demand). */
  describeTools(): ToolDescriptor[] | Promise<ToolDescriptor[]>;
  /** Executes a tool call. Provider stays trace-unaware (D-09); executor wraps with timing. */
  executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult>;
}

/**
 * Federation helper — D-11.
 *
 * Holds a set of `ToolProvider` instances keyed by provider id, plus a
 * tool-name → provider lookup map for O(1) dispatch. Multi-executor
 * consumers (e.g., Hermes shipping multiple agents) share one registry
 * across executor instances; each executor calls `describeAll()` once at
 * construction.
 *
 * Conflict semantics: two providers claiming the same tool name throws
 * `DuplicateToolNameError` — silent overwrite would create a configuration
 * drift (an instrumentation drift) that no test would catch.
 * Mirrors Phase 2 `AgentRegistry`'s `DuplicateAgentTypeError` discipline.
 */
export class ToolProviderRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly toolToProvider = new Map<string, ToolProvider>();
  private readonly pendingClaims: Promise<void>[] = [];

  /**
   * Register a provider. Throws `DuplicateToolNameError` if any tool
   * name claimed by `provider.describeTools()` is already registered to
   * a different provider — opt out with `{ replace: true }`.
   *
   * Throws `DuplicateToolNameError(provider.id, provider.id)` (using the
   * provider id as the conflict key) if a provider with the same id is
   * already registered and `options?.replace !== true`.
   *
   * NOTE: `register()` is synchronous; if `provider.describeTools()` returns a
   * Promise, the claim is tracked in `pendingClaims` and awaited by `ready()`
   * (and transitively by `describeAll()`). Callers MUST `await registry.ready()`
   * (or `await registry.describeAll()`) before invoking `providerFor()` for any
   * async-providing provider. Tests SC2.4 covers federation; SC2.8b + SC2.9b
   * cover the post-`ready()` providerFor() invariant.
   */
  register(provider: ToolProvider, options?: { replace?: boolean }): void {
    if (this.providers.has(provider.id) && options?.replace !== true) {
      throw new DuplicateToolNameError(provider.id, provider.id);
    }
    this.providers.set(provider.id, provider);

    const toolList = provider.describeTools();
    const claim = (descriptors: ToolDescriptor[]): void => {
      for (const desc of descriptors) {
        const existing = this.toolToProvider.get(desc.name);
        if (existing && existing.id !== provider.id && options?.replace !== true) {
          throw new DuplicateToolNameError(desc.name, provider.id);
        }
        this.toolToProvider.set(desc.name, provider);
      }
    };
    if (toolList instanceof Promise) {
      // Track the promise so describeAll() / ready() can await it. Errors
      // propagate to the awaiter (claim() may throw DuplicateToolNameError
      // mid-resolve when a conflicting tool name is discovered post-register).
      this.pendingClaims.push(toolList.then(claim));
    } else {
      claim(toolList);
    }
  }

  /**
   * Wait for all async `describeTools()` claims registered so far to settle.
   * Idempotent and cheap — empty array resolves immediately. Callers that
   * need to invoke `providerFor()` for async-providing providers MUST await
   * this (or `describeAll()`, which awaits this internally) first.
   *
   * Added per Phase 7 D-13 to close the async-claim race that previously
   * required test-side pre-priming + setImmediate microtask drains.
   */
  async ready(): Promise<void> {
    if (this.pendingClaims.length === 0) return;
    await Promise.all(this.pendingClaims);
  }

  /** Returns the provider that owns `toolName`, or undefined if none. */
  providerFor(toolName: string): ToolProvider | undefined {
    return this.toolToProvider.get(toolName);
  }

  /** Returns every registered provider in registration order. Array is a fresh copy. */
  getAll(): ToolProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Federate every provider's tool descriptors into one array. Awaits
   * any async `describeTools()` calls. Used by the executor at run start
   * to seed `ChatRequest.tools`.
   *
   * Settles pending register-time claims FIRST (via `ready()`) so
   * `toolToProvider` is fully populated before federation. Without this,
   * `providerFor(toolName)` called mid-run could observe a partial map
   * for async providers (the pre-D-13 race window).
   */
  async describeAll(): Promise<ToolDescriptor[]> {
    await this.ready();
    const results = await Promise.all(
      Array.from(this.providers.values()).map((p) => Promise.resolve(p.describeTools())),
    );
    return results.flat();
  }
}
