/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Kernel `ChatRequest` → OpenAI POST body + headers (D-08 + D-12).
 *
 * Pure mapping per D-12; no I/O, no fetch, no provider SDK names.
 * `stream_options.include_usage: true` is set whenever stream=true so the
 * backend emits a terminal usage chunk (CONTEXT D-13 + RESEARCH §Pitfall 1).
 *
 * **Security (T-LLM-01):** the apiKey is interpolated INTO the Authorization
 * header value — it MUST NOT be logged, MUST NOT appear in any error string,
 * MUST NOT be echoed in default-headers merge. The function only ever
 * READS opts.apiKey; never WRITES it anywhere except the returned headers
 * Record (which the client.ts fetch call consumes immediately and never logs).
 */

import type { ChatRequest, ChatMessage } from '@kagent/agent-loop';
import {
  toOpenAITools,
  toOpenAIToolCalls,
  type OpenAITool,
  type OpenAIToolCallWire,
} from './tool-mapper.js';

/**
 * OpenAI wire-format message shape — the kernel's `ChatMessage.tool_calls`
 * uses `{id, name, args}` (internal canonical) while OpenAI's spec requires
 * `{id, type: 'function', function: {name, arguments: JSON-string}}`. This
 * interface is what actually lands on the wire after `toOpenAIWireMessage`.
 */
export interface OpenAIWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OpenAIToolCallWire[];
  tool_call_id?: string;
  name?: string;
}

/** OpenAI POST body shape — internal to the adapter. */
export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIWireMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: true };
}

/**
 * Translate a single kernel `ChatMessage` into the OpenAI wire shape.
 *
 * Only `role: 'assistant'` messages with `tool_calls` need structural
 * translation — the nested `function.{name, arguments: JSON-string}`
 * envelope is what the spec requires on echo-back turns. Other roles
 * pass through (content + role + optional tool_call_id/name).
 *
 * Without this translation, OpenAI-compat backends (Ollama, LiteLLM, vLLM)
 * reject the continuation request with HTTP 400 "invalid tool call
 * arguments" — they see the kernel's internal `{name, args}` instead of
 * the nested `function.{name, arguments}` the spec requires.
 */
export function toOpenAIWireMessage(m: ChatMessage): OpenAIWireMessage {
  const out: OpenAIWireMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls !== undefined && m.tool_calls.length > 0) {
    const wireCalls = toOpenAIToolCalls(m.tool_calls);
    if (wireCalls !== undefined) out.tool_calls = wireCalls;
  }
  if (m.role === 'tool') {
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    // `name` on tool messages is optional in the OpenAI spec and redundant
    // with tool_call_id — include it only if the kernel supplied it, for
    // backends that accept/require it.
    if (m.name !== undefined) out.name = m.name;
  }
  return out;
}

/**
 * Build the OpenAI POST body from a kernel ChatRequest.
 *
 * Each `ChatMessage` is translated via `toOpenAIWireMessage` so
 * assistant-with-tool_calls messages echo back in the spec-correct nested
 * `function.{name, arguments: JSON-string}` envelope. `systemPrompt` is
 * prepended as a `role: 'system'` message if set. `request.model`
 * overrides the default.
 */
export function buildOpenAIRequestBody(
  request: ChatRequest,
  defaultModel: string,
  options: { stream: boolean },
): OpenAIRequestBody {
  const kernelMessages: ChatMessage[] = request.systemPrompt
    ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
    : [...request.messages];
  const messages: OpenAIWireMessage[] = kernelMessages.map(toOpenAIWireMessage);

  const body: OpenAIRequestBody = {
    model: request.model ?? defaultModel,
    messages,
    stream: options.stream,
  };

  // exactOptionalPropertyTypes: never assign undefined to optional fields.
  const tools = toOpenAITools(request.tools);
  if (tools !== undefined) body.tools = tools;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body.stop = [...request.stopSequences];
  }
  if (options.stream) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

/**
 * Build the request headers.
 *
 * - `Content-Type: application/json` always
 * - `Accept: text/event-stream` when stream=true; `application/json` otherwise
 * - `Authorization: Bearer <apiKey>` when apiKey is set
 * - Merges in defaultHeaders LAST so callers can override Accept (Azure)
 *   or add bespoke routing headers (`api-version`, `x-litellm-*`).
 *
 * **T-LLM-01:** never logs apiKey value. The returned Record is the only
 * place apiKey appears.
 */
export function buildOpenAIHeaders(
  apiKey: string | undefined,
  defaultHeaders: Record<string, string>,
  options: { stream: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: options.stream ? 'text/event-stream' : 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // defaultHeaders LAST — explicit caller override wins
  for (const [k, v] of Object.entries(defaultHeaders)) {
    headers[k] = v;
  }
  return headers;
}
