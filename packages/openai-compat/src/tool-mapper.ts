/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Bidirectional MCP ToolDescriptor ↔ OpenAI tool envelope translation (D-12).
 *
 * Pure mapping per D-12; no I/O, no fetch, no provider SDK names. The kernel
 * uses MCP-aligned `inputSchema` field; OpenAI calls it `parameters`. The
 * adapter is the sole place where these field names appear together.
 *
 * `function.arguments` in OpenAI's response is a JSON-STRING (not an object);
 * `fromOpenAIToolCalls` JSON.parses it into `ToolCall.args: unknown` per Phase 3
 * `llm-client.ts:43-47` — "Already JSON-parsed by the kernel; provider narrows
 * downstream."
 */

import type { ToolDescriptor, ToolCall } from '@kagent/agent-loop';
import { LLMClientProtocolError } from '@kagent/agent-loop';

/** OpenAI `tools[i]` shape — internal to the adapter. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema pass-through
  };
}

/** Wire shape of a single tool_call in `choices[0].message.tool_calls[]`. */
export interface OpenAIToolCallWire {
  id: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string; // JSON-string
  };
}

/**
 * Translate a kernel `ToolDescriptor[]` into the OpenAI `tools` request field.
 *
 * Returns `undefined` (NOT an empty array) when input is undefined or empty —
 * `buildOpenAIRequestBody` relies on this to OMIT the `tools` field from
 * the wire body when the consumer didn't supply tools (vs. sending
 * `tools: []` which some backends treat differently).
 */
export function toOpenAITools(
  tools: readonly ToolDescriptor[] | undefined,
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Translate a kernel `ToolCall[]` into the OpenAI wire `tool_calls[]` shape
 * for `role: 'assistant'` messages that echo a prior model-issued tool call
 * back into the conversation on continuation turns.
 *
 * - Kernel shape: `{ id, name, args }` where `args` is `unknown` (parsed)
 * - OpenAI wire : `{ id, type: 'function', function: { name, arguments } }`
 *                  where `arguments` is a JSON-STRING per the OpenAI spec
 *
 * Without this translation, OpenAI-compat backends (Ollama, LiteLLM, vLLM)
 * reject the continuation turn with HTTP 400 "invalid tool call arguments"
 * because they see the kernel's internal `{ name, args }` instead of the
 * nested `function.{name,arguments:string}` the spec requires.
 *
 * Returns `undefined` when input is undefined or empty — `toOpenAIWireMessage`
 * relies on this to omit the `tool_calls` field when the assistant message
 * has no tool calls.
 */
export function toOpenAIToolCalls(
  calls: readonly ToolCall[] | undefined,
): OpenAIToolCallWire[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: {
      name: c.name,
      // Round-trip-safe: kernel stored args as parsed `unknown`; we re-encode
      // as JSON-string for the wire. Matches `fromOpenAIToolCalls` which
      // JSON.parses on ingress.
      arguments: JSON.stringify(c.args ?? {}),
    },
  }));
}

/**
 * Strip a Qwen/Hermes-style `<tool_call>...</tool_call>` chat-template
 * closing tag that some vLLM tool-call parsers leak into
 * `function.name` when the model's in-tag JSON doesn't come out clean
 * (observed against Qwen3-Coder-Next on vLLM as e.g.
 * `"browser.goto\n</tool_call>"` or `"browser.start_session=\n</tool_call>"`).
 * Truncates at the first `</tool_call` marker, then trims a dangling `=`
 * and whitespace some malformed emissions leave behind. A no-op for
 * well-formed names from every other backend (Ollama, LocalAI,
 * Cloudflare) since none of them contain this substring.
 */
function sanitizeToolCallName(name: string): string {
  const tagIndexes = [name.indexOf('</tool_call'), name.indexOf('<parameter=')].filter(
    (index) => index >= 0,
  );
  const tagIndex = tagIndexes.length === 0 ? -1 : Math.min(...tagIndexes);
  const truncated = tagIndex === -1 ? name : name.slice(0, tagIndex);
  return truncated.replace(/=\s*$/, '').trim();
}

/**
 * Translate the OpenAI `choices[0].message.tool_calls[]` array back into the
 * kernel's `ToolCall[]` shape.
 *
 * `function.arguments` is JSON-string-encoded on the wire; this function
 * `JSON.parse`s it into `ToolCall.args: unknown`. Parse failure throws
 * `LLMClientProtocolError` carrying the offending string for caller debug.
 *
 * Returns `undefined` when input is undefined or empty.
 */
export function fromOpenAIToolCalls(
  raw: readonly OpenAIToolCallWire[] | undefined,
): ToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc) => {
    let args: unknown;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      throw new LLMClientProtocolError(
        `tool_call function.arguments is not valid JSON (tool_call id=${tc.id}, name=${tc.function.name})`,
        tc.function.arguments,
      );
    }
    return {
      id: tc.id,
      name: sanitizeToolCallName(tc.function.name),
      args,
    };
  });
}
