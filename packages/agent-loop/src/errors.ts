/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Error types thrown by `AgentRegistry` and `AgentExecutor`.
 *
 * Two parent classes (`AgentRegistryError`, `AgentExecutorError`) anchor
 * separate family branches; consumers can catch broadly:
 *
 * ```ts
 * try { await executor.run(input); }
 * catch (err) {
 *   if (err instanceof AgentExecutorError) { // executor-side error }
 *   if (err instanceof AgentRegistryError) { // registry-side error }
 * }
 * ```
 *
 * Individual subclasses carry typed fields (`.type`, `.skillId`, `.agentType`,
 * `.toolName`, `.field`, `.capability`, `.providerId`) so consumers branch on
 * the specific failure without string parsing. Per D-22, executor-side
 * exceptions are reserved for PROGRAMMER errors — runtime failures resolve
 * to `ExecutionResult` with `status` set instead.
 */

/**
 * Parent class for every error thrown by `AgentRegistry`.
 *
 * Subclasses rely on `new.target.name` to set `this.name` so each
 * caught instance reports its concrete class name without per-subclass
 * boilerplate. The `Object.setPrototypeOf` call restores the prototype
 * chain under tsup's ESM + CJS dual-emit so `instanceof` works both
 * own-subclass and parent-class.
 */
export class AgentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain — defensive under ES target downgrade or dual-emit.
    Object.setPrototypeOf(this, new.target.prototype);
    // V8-only API; guarded for future non-Node runtimes.
    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown by `AgentRegistry.register()` when `def.type` is already
 * registered and `{ replace: true }` was not set.
 */
export class DuplicateAgentTypeError extends AgentRegistryError {
  /** The duplicate agent type tag that caused the throw. */
  public readonly type: string;

  constructor(type: string) {
    super(`Agent type "${type}" is already registered`);
    this.type = type;
  }
}

/**
 * Thrown by `AgentRegistry.register()` when two entries in `def.skills`
 * share an `id`.
 */
export class DuplicateSkillIdError extends AgentRegistryError {
  /** The agent type that owned the duplicate skill. */
  public readonly type: string;
  /** The duplicate skill id. */
  public readonly skillId: string;

  constructor(type: string, skillId: string) {
    super(`Agent "${type}" has duplicate skill id "${skillId}"`);
    this.type = type;
    this.skillId = skillId;
  }
}

/**
 * Thrown when a lookup or recommendation targets an unregistered type.
 */
export class UnknownAgentTypeError extends AgentRegistryError {
  /** The unknown agent type that was queried. */
  public readonly type: string;

  constructor(type: string) {
    super(`Agent type "${type}" is not registered`);
    this.type = type;
  }
}

// =====================================================================
// Phase 3 — AgentExecutor error family (D-22)
// =====================================================================

/**
 * Parent class for every error thrown by `AgentExecutor`.
 *
 * Same prototype-restoration + stack-trace-capture pattern as
 * `AgentRegistryError`. Consumers can catch executor-family errors with:
 *
 * ```ts
 * try { await executor.run(input); }
 * catch (err) { if (err instanceof AgentExecutorError) { // handle } }
 * ```
 */
export class AgentExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain — defensive under ES target downgrade or dual-emit.
    Object.setPrototypeOf(this, new.target.prototype);
    // V8-only API; guarded for future non-Node runtimes.
    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when `AgentExecutor.run()` is called with an agent type the
 * registry doesn't know.
 */
export class AgentNotFoundError extends AgentExecutorError {
  /** The agent type that was not registered. */
  public readonly agentType: string;

  constructor(agentType: string) {
    super(`Agent type "${agentType}" is not registered with the executor's registry`);
    this.agentType = agentType;
  }
}

/**
 * Thrown by the `AgentExecutor` constructor when no `LLMClient` instance
 * is supplied.
 */
export class NoLLMClientError extends AgentExecutorError {
  constructor() {
    super('AgentExecutor requires an LLMClient instance; none was supplied');
  }
}

/**
 * Thrown when a `tool_call` references a tool name that no registered
 * provider owns. Surfaced through the trace as an error, NOT as an
 * executor-level throw — this class exists for programmer-error paths
 * (e.g., constructing a `ToolProviderRegistry` lookup with no providers).
 */
export class NoToolProviderError extends AgentExecutorError {
  /** The tool name that no registered provider claimed. */
  public readonly toolName: string;

  constructor(toolName: string) {
    super(`No registered tool provider claims tool "${toolName}"`);
    this.toolName = toolName;
  }
}

/**
 * Thrown for invalid `AgentExecutor` configuration (e.g., maxIterations=0
 * or negative; budget cap negative).
 */
export class InvalidConfigError extends AgentExecutorError {
  /** The configuration field that was invalid. */
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid configuration for "${field}": ${message}`);
    this.field = field;
  }
}

/**
 * Thrown by `LLMClient` impls that omit an optional capability the consumer
 * requested (e.g., calling `embed()` on an impl that didn't define it).
 * Per RESEARCH §8 Q3, the recommended pattern is to OMIT the optional
 * method entirely — this class exists for impls that prefer to throw
 * with a typed error.
 */
export class NotImplementedError extends AgentExecutorError {
  /** The capability name (e.g., 'embed') the impl omits. */
  public readonly capability: string;

  constructor(capability: string) {
    super(`Capability "${capability}" is not implemented by this client`);
    this.capability = capability;
  }
}

/**
 * Thrown by `ToolProviderRegistry.register()` when two providers claim
 * the same tool name (or when a provider id is registered twice). Opt
 * out with `{ replace: true }`.
 *
 * Mirrors Phase 2 `DuplicateAgentTypeError` discipline — silent overwrite
 * would create configuration drift that no test would catch.
 */
export class DuplicateToolNameError extends AgentExecutorError {
  /** The conflicting tool name (or provider id, when an id collision triggers the throw). */
  public readonly toolName: string;
  /** The id of the provider attempting to register the conflicting name. */
  public readonly providerId: string;

  constructor(toolName: string, providerId: string) {
    super(`Tool name "${toolName}" is already claimed (provider "${providerId}")`);
    this.toolName = toolName;
    this.providerId = providerId;
  }
}

// =====================================================================
// Phase 4 — LLMClient error family (D-16)
// =====================================================================

/**
 * Parent class for every error thrown by an `LLMClient` adapter
 * (e.g., `@ctkadvisors/openai-compat-client`).
 *
 * Same prototype-restoration + stack-trace-capture pattern as
 * `AgentRegistryError` and `AgentExecutorError`. Consumers can catch
 * adapter-family errors with:
 *
 * ```ts
 * try { await llm.chat(req, ctx); }
 * catch (err) { if (err instanceof LLMClientError) { // handle } }
 * ```
 *
 * Subclasses do NOT extend `AgentExecutorError` — adapter errors and
 * executor errors are sibling families. The executor maps `LLMClientError`
 * subclasses to `ExecutionResult.status` (see `executor.ts` catch arms);
 * consumers see the typed status, not the underlying class.
 *
 * **Security note (T-LLM-01):** `message` is the only stringly-formatted
 * field the parent constructor accepts. Subclasses carry typed fields
 * (`.status`, `.body`, `.requestId`, `.raw`, `.timeoutMs`) so consumers
 * branch without parsing strings. Adapter call sites MUST pre-truncate
 * `body` via `truncateForStorage()` and MUST NOT interpolate request
 * headers (which carry `Authorization: Bearer ...`) into any field.
 */
export class LLMClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain — defensive under ES target downgrade or dual-emit.
    Object.setPrototypeOf(this, new.target.prototype);
    // V8-only API; guarded for future non-Node runtimes.
    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Non-2xx HTTP response from an LLM backend.
 *
 * `status` always populated; `body` is the response body truncated to ~700
 * characters at the call site via `truncateForStorage()` (see `trace.ts`);
 * `requestId` is the upstream's `x-request-id` response header when present.
 *
 * The constructor's `body` parameter is REQUIRED to be already-truncated by
 * the call site — the constructor does NOT call `truncateForStorage` itself.
 * This keeps the error class dumb and avoids a circular import from `errors.ts`
 * to `trace.ts`.
 */
export class LLMClientHttpError extends LLMClientError {
  /** HTTP status code from the backend (e.g., 429, 500, 503). */
  public readonly status: number;
  /** Truncated response body for debug. Adapter call site truncates via `truncateForStorage()`. */
  public readonly body?: string;
  /** Upstream's `x-request-id` response header when present (OpenAI direct, vLLM). */
  public readonly requestId?: string;

  constructor(status: number, body?: string, requestId?: string) {
    super(`LLM backend returned HTTP ${status}`);
    this.status = status;
    // exactOptionalPropertyTypes: never assign `undefined` to optional fields.
    if (body !== undefined) this.body = body;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

/**
 * Response shape doesn't match expected protocol — missing fields, malformed
 * SSE event, JSON.parse failure on response body, missing `choices` array, etc.
 *
 * `raw` carries the offending payload (string for SSE; unknown for JSON.parse
 * results) for caller debug. Type is `unknown` so the consumer narrows
 * defensively.
 */
export class LLMClientProtocolError extends LLMClientError {
  /** The offending raw payload (SSE event string, parsed JSON, etc.). */
  public readonly raw: unknown;

  constructor(message: string, raw: unknown) {
    super(`LLM protocol error: ${message}`);
    this.raw = raw;
  }
}

/**
 * Fetch aborted via `AbortSignal`. Translated by the adapter from the
 * native `DOMException { name: 'AbortError' }` that Node 22 fetch / undici
 * throws when `ctx.abortSignal.abort()` fires (D-15).
 *
 * Parameter-free — abort is a binary signal; no metadata to attach.
 */
export class LLMClientAbortError extends LLMClientError {
  constructor() {
    super('LLM request aborted via AbortSignal');
  }
}

/**
 * Reserved for future timeout wiring; not raised in Phase 4 (D-16 reserved slot).
 *
 * Phase 4 adapters do NOT impose timeouts internally — D-17 forbids the
 * adapter from owning timeout policy (consumer concern). When a future phase
 * (or consumer wrapper) layers timeout enforcement on top of `chat()` /
 * `chatStream()`, this is the typed throw it surfaces.
 */
export class LLMClientTimeoutError extends LLMClientError {
  /** Timeout window in milliseconds that elapsed before the request completed. */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

// =====================================================================
// Phase 5 — ToolProvider error family (D-24)
// =====================================================================

/**
 * Parent class for every error thrown by a `ToolProvider` adapter
 * (`@ctkadvisors/http-tool-provider`, `@ctkadvisors/mcp-tool-provider`).
 *
 * Same prototype-restoration + stack-trace-capture pattern as
 * `AgentRegistryError`, `AgentExecutorError`, and `LLMClientError`.
 * Consumers catch the family broadly:
 *
 * ```ts
 * try { await provider.executeTool(call, ctx); }
 * catch (err) { if (err instanceof ToolProviderError) { ... } }
 * ```
 *
 * Adapter, executor, LLM-client, and tool-provider errors are all SIBLING
 * families: a `HttpToolProviderNetworkError` thrown by an adapter is NOT
 * `instanceof AgentExecutorError` and NOT `instanceof LLMClientError`. The
 * executor (executor.ts:452-482) catches the family separately and maps
 * tool-provider throws to `ToolResult{isError:true, content:'Error: ...'}`
 * per the loop convention.
 *
 * Note: `InProcessToolProvider` has no provider-level failure mode (D-26)
 * — handler throws map to `ToolResult{isError:true}` (D-20) not propagated.
 * If a future case emerges, add an `InProcessToolProviderError` subclass.
 */
export class ToolProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain — defensive under ES target downgrade or dual-emit.
    Object.setPrototypeOf(this, new.target.prototype);
    // V8-only API; guarded for future non-Node runtimes.
    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Network-level failure inside `HttpToolProvider` — DNS resolution failed,
 * connection refused, fetch threw a `TypeError`, or `ctx.abortSignal`
 * fired (which Node 22 fetch / undici surfaces as `DOMException` with
 * `name === 'AbortError'`).
 *
 * The provider classifies the underlying throw and rethrows this typed
 * error so the executor's exception handler can map to `ToolResult`
 * uniformly (executor.ts:452-482).
 */
export class HttpToolProviderNetworkError extends ToolProviderError {}

/**
 * Programmer-error inside `HttpToolProvider` — the tool definition has
 * an unmatched `{placeholder}` in `path` for which the LLM did not
 * supply a matching argument key, the HTTP method is invalid, or
 * similar configuration mistake surfaced at execute time.
 *
 * Distinguished from `HttpToolProviderNetworkError` so consumer error
 * classifiers can branch (config error → fail loud; network error →
 * possibly retry).
 */
export class HttpToolProviderConfigError extends ToolProviderError {}

/**
 * MCP server-side protocol failure — JSON-RPC error envelope returned by
 * the server (`InvalidRequest`, `MethodNotFound`, `InvalidParams`,
 * `InternalError`, `ParseError`), schema mismatch on response shape, or
 * `RequestTimeout` returned when `signal.aborted === false` (server-side
 * hang, NOT consumer abort).
 *
 * The MCP SDK throws `McpError` with `.code` from the `ErrorCode` enum;
 * the provider classifies and rethrows as this typed error. See
 * RESEARCH.md §Mapping table for the per-code mapping.
 *
 * Note: `result.isError === true` (tool-execution error in the MCP
 * response) is NOT a protocol error — that flows back to the LLM as
 * `ToolResult{isError:true}` per CONTEXT D-16. This subclass is only
 * for protocol-layer failures.
 */
export class McpToolProviderProtocolError extends ToolProviderError {}

/**
 * MCP subprocess lifecycle failure — `child_process.spawn` failed
 * (ENOENT — command not found), the child exited unexpectedly mid-call
 * (SDK throws `McpError` with `code === ErrorCode.ConnectionClosed`),
 * or the provider was used after `close()`.
 *
 * The provider's `ensureConnected()` catches spawn failures and
 * `executeTool()` catches `ConnectionClosed`; both rethrow as this
 * typed error.
 */
export class McpToolProviderSubprocessError extends ToolProviderError {}

/**
 * MCP request aborted via `AbortSignal`. Translated by the provider
 * from the SDK's `McpError(ErrorCode.RequestTimeout, ...)` when
 * `signal.aborted === true` (RESEARCH.md §RequestOptions — AbortSignal
 * is native to the SDK).
 *
 * Parameter-free — abort is a binary signal; no metadata to attach.
 * Mirrors `LLMClientAbortError` (Phase 4 D-16) verbatim.
 */
export class McpToolProviderAbortError extends ToolProviderError {
  constructor() {
    super('MCP tool call aborted via AbortSignal');
  }
}
