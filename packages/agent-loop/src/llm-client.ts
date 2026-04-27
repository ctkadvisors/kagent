/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Type declarations for the vendor-agnostic `LLMClient` interface.
 *
 * Type-only module — erased at emit time under `verbatimModuleSyntax: true`.
 * Contributes zero runtime bytes to `dist/`. Nothing in this module imports
 * any provider SDK; vendor-specific types never leak across the loop
 * boundary.
 *
 * The canonical `ChatMessage` shape is a STANDARDS pick (every major provider
 * SDK normalizes to this shape; the adapter layer translates content blocks ↔
 * `tool_calls` inside the impl). It is NOT a vendor pick. See
 * See docs/HARNESS-LESSONS.md.
 *
 * Field schemas trace to D-01..D-06 + D-30 (forward-compat). The `ChatDelta`
 * field surface is intentionally minimal in Phase 3 — Phase 4's first
 * `LLMClient` impl pressure-tests and may extend additively (per D-03).
 */

import type { ToolDescriptor } from './tool-provider.js';

/**
 * Vendor-neutral tool call as represented in chat history — D-08.
 *
 * Kernel uses a FLAT shape: `{ id, name, args }`. The source repo uses an
 * envelope shape that nests name and arguments under a typed sub-object;
 * `LLMClient` impls translate to provider-specific envelopes (envelope-style
 * on the wire for some backends, content blocks of type tool_use for
 * others) when sending messages back to the wire. Kernel never sees the
 * envelope.
 *
 * `args` is `unknown` — JSON parsed by the loop before reaching the
 * `ToolProvider`; provider narrows with its own validator.
 */
export interface ToolCall {
  /** Stable correlation id between the model's tool_call request and the tool result message.
   *  Kernel synthesizes a fallback id when the model omits one (some Llama 4 / Workers AI variants). */
  id: string;
  /** Tool name. Matches a `ToolDescriptor.name` registered with the executor's `ToolProviderRegistry`. */
  name: string;
  /** Tool input arguments. Already JSON-parsed by the loop; provider narrows downstream. */
  args: unknown;
}

/**
 * Canonical-shape chat message — D-01.
 *
 * Every major provider SDK normalizes to this shape; provider-native
 * content-blocks formats are translated INSIDE the `LLMClient` impl,
 * never reaching the loop.
 */
export interface ChatMessage {
  /** Role union — exactly four values. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message content. For `assistant` messages with tool calls, may be empty string. */
  content: string;
  /** Populated when `role === 'assistant'` and the model wants to invoke tools. */
  tool_calls?: ToolCall[];
  /** Populated when `role === 'tool'` — links back to the assistant's `tool_calls[i].id`. */
  tool_call_id?: string;
  /** Tool name when `role === 'tool'`. */
  name?: string;
}

/**
 * Request shape for `LLMClient.chat()` and `LLMClient.chatStream()` — D-02 + D-05.
 *
 * Minimal-surface design: keeps ergonomic fields every major provider supports;
 * provider-specific knobs (top_p, frequency_penalty, etc.) live in the impl
 * layer. `model` is optional because consumers may pre-bind one model per
 * `LLMClient` instance.
 */
export interface ChatRequest {
  /** Conversation history. Append `assistant` messages with `tool_calls` and `tool` messages with results to continue. */
  messages: ChatMessage[];
  /** Optional model override (e.g., swap a large model for a small one on cheap calls). Provider-shaped string passed through. */
  model?: string;
  /** MCP-shape tool descriptors. Empty/omitted = no tools. Impl translates to provider format. */
  tools?: readonly ToolDescriptor[];
  /** Conventional 0.0..2.0 range; impl clamps to provider's accepted range. */
  temperature?: number;
  /** Hard cap on output tokens; impl translates to provider's `max_tokens` / `max_completion_tokens` etc. */
  maxTokens?: number;
  /** Stop sequences; rarely used in tool-use loops but a standard knob. */
  stopSequences?: readonly string[];
  /** Optional system prompt as a SEPARATE field. Impl decides whether to embed as a `role: 'system'` message
   *  or pass through the provider-specific `system` parameter. If set, callers SHOULD NOT also include
   *  a `role: 'system'` message in `messages`. */
  systemPrompt?: string;
}

/**
 * Result shape for `LLMClient.chat()` — D-02.
 *
 * `usage` and `stopReason` are optional; impls that can't populate them leave
 * undefined, executor degrades gracefully (falls back to `countTokens()` for
 * budget; treats absent stopReason as "model finished" if no `tool_calls`).
 */
export interface ChatResult {
  /** Final text content from the model. May be empty when the model only emits tool_calls. */
  content: string;
  /** Tool calls the model wants the consumer to invoke. */
  tool_calls?: ToolCall[];
  /** Backend-reported usage. The loop never derives `costUsd` from tokens — see D-16. */
  usage?: {
    /** Backend-reported input token count. Undefined when backend omits. */
    inputTokens?: number;
    /** Backend-reported output token count. Undefined when backend omits. */
    outputTokens?: number;
    /** Backend-reported cost in USD. Undefined when backend doesn't report (Workers AI, Ollama, Exo). */
    costUsd?: number;
  };
  /** Mapped from provider's stop reason (see RESEARCH §8 Q5 mapping table). Provider-specific
   *  reasons that don't map cleanly leave this undefined; executor treats undefined as `'end_turn'`. */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

/**
 * Streaming delta — D-03.
 *
 * Field-shape lock deferred to Phase 4 first impl pressure-test. Phase 3 ships
 * the minimal placeholder shape; extensions MUST be additive (fields can be
 * added optionally; existing fields cannot change semantics).
 */
export interface ChatDelta {
  /** Incremental text content. Concatenate across deltas to assemble the final content. */
  content?: string;
  /** Incremental tool-call deltas. Phase 4 first impl defines exact merge semantics; minimal lock
   *  is "an array of partial ToolCall fragments to merge by index or id." */
  tool_calls?: Array<Partial<ToolCall>>;
  /** Final usage stats; populated only on the LAST delta in the stream. */
  usage?: ChatResult['usage'];
  /** Final stop reason; populated only on the LAST delta. */
  stopReason?: ChatResult['stopReason'];
}

/**
 * Optional context passed to `chat()` / `chatStream()` — D-06 + D-30.
 *
 * Impls MUST honor `abortSignal` (wire to fetch options or HTTP client cancellation).
 * `idempotencyKey` is a forward-compat slot for retry-safe consumers; M1
 * impls may ignore. M2's authority band injects an `authority?: AuthorityToken`
 * field here that impls gate on before dispatch.
 */
export interface ClientContext {
  /** Per-run correlation id; flows into traces. */
  runId: string;
  /** Cancellation handle owned by the consumer (executor wires this through from `RunInput.signal`). */
  abortSignal: AbortSignal;
  // forward-compat slots (inert in M1; consumed by later phases)
  /** Forward-compat slot (inert in M1; consumed by M2 retry-safe consumers). */
  idempotencyKey?: string;
}

/**
 * Vendor-agnostic LLM client.
 *
 * `chat()` and `chatStream()` semantically do the same work; impls SHOULD
 * implement `chatStream()` as the primary path and have `chat()` fold the
 * stream to a single result. Some providers only support non-streaming
 * (raw HTTP without SSE) — those impls should make `chatStream()` yield
 * exactly one delta containing the full result.
 *
 * `countTokens()` MUST be implemented (no fallback to a 4-char heuristic at
 * the loop level — that's the executor's degradation path when usage is
 * missing). May be sync or async; a provider's tokenizer is sometimes lazy-loaded.
 *
 * `embed()` is OPTIONAL — no M1 consumer needs embeddings. Impls that don't
 * support it OMIT the property entirely; consumers must check `'embed' in client`
 * before calling (RESEARCH §8 Q3).
 */
export interface LLMClient {
  chat(request: ChatRequest, ctx?: ClientContext): Promise<ChatResult>;
  chatStream(request: ChatRequest, ctx?: ClientContext): AsyncIterable<ChatDelta>;
  countTokens(input: string | ChatMessage[]): Promise<number> | number;
  embed?(input: string | string[]): Promise<number[][]>;
}
