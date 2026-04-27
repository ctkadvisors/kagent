/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@ctkadvisors/openai-compat-client` — first concrete `LLMClient` impl for
 * `@kagent/agent-loop`. Speaks OpenAI Chat Completions v1 against any
 * compatible backend (Exo, Ollama, vLLM, LiteLLM proxy, OpenAI direct,
 * Workers AI compat, Azure OpenAI). See README compatibility matrix.
 *
 * Errors thrown by this client (`LLMClientError` + 4 subclasses) are exported
 * from `@kagent/agent-loop` (Phase 4 D-16); consumers import them from there
 * to avoid dual-source `instanceof` ambiguity.
 */

// =====================================================================
// Phase 4 — OpenAI-compatible LLMClient public API
// =====================================================================

/**
 * First concrete `LLMClient` impl for `@kagent/agent-loop`.
 * Construct with `{ baseUrl, model, apiKey?, defaultHeaders?, fetch? }` per D-08.
 */
export { OpenAICompatibleLLMClient } from './client.js';
export type { OpenAICompatibleLLMClientOptions } from './client.js';

/**
 * Streaming tool-call delta surface (D-10 narrowing of Phase 3
 * `ChatDelta.tool_calls`). Emitted by `chatStream()` deltas; caller
 * merges fragments by `index` and concatenates `args_delta` strings
 * to assemble each `ToolCall`.
 */
export type { ToolCallDelta } from './sse-parser.js';
