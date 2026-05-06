/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * OpenAI Chat Completion JSON → kernel `ChatResult` (D-12).
 *
 * Pure mapping per D-12; no I/O, no fetch. The adapter is the sole place
 * where OpenAI-shape field names (`prompt_tokens`, `completion_tokens`,
 * `finish_reason`, `tool_calls.function.arguments`) appear in the codebase.
 *
 * **`costUsd` propagation (Plan 07-04 Rule 2 extension):** the LiteLLM-style
 * non-standard `usage.cost_usd` field is propagated through to
 * `ChatResult.usage.costUsd` WHEN the upstream returns it. The plain Exo /
 * Ollama / vLLM / Workers AI path still leaves `costUsd` undefined (those
 * backends don't emit `cost_usd`); the LiteLLM-proxy + mock test fixture
 * path now surfaces cost end-to-end into `RunBudget.cumulativeCostUsd`,
 * unblocking the Phase 7 paperclip acceptance gate (SC1+SC2 — record token
 * + USD cost on every LLM call). Per Phase 3 D-16 the kernel never DERIVES
 * cost from tokens — backend-reported only.
 */

import type { ChatResult } from '@kagent/agent-loop';
import { LLMClientProtocolError } from '@kagent/agent-loop';
import { mapFinishReason } from './stop-reason-map.js';
import { fromOpenAIToolCalls, type OpenAIToolCallWire } from './tool-mapper.js';

/**
 * Anthropic-style content block (single text/tool_use entry).
 *
 * NON-STANDARD shape that some OpenAI-compat backends (Cloudflare Workers AI's
 * Llama 4 Scout via LiteLLM, the Anthropic-via-LiteLLM passthrough) leak into
 * `message.content` instead of normalizing to a flat string. The mapper coerces
 * these to a string at the boundary so the kernel `ChatResult.content: string`
 * contract is honored.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text?: unknown }
  | { type: 'tool_use'; id?: unknown; name?: unknown; input?: unknown }
  | { type: string; [k: string]: unknown };

/** OpenAI Chat Completion response shape — internal to the adapter. */
export interface OpenAIChatCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message: {
      role: string;
      /**
       * Wire-format reality: most backends emit `string | null`. Cloudflare
       * Workers AI's Llama 4 Scout (via LiteLLM workers-ai provider) emits an
       * array of Anthropic-style content blocks; the Anthropic-via-LiteLLM
       * passthrough does the same. The mapper normalizes all four shapes
       * (`null` / `string` / `AnthropicContentBlock` / `AnthropicContentBlock[]`)
       * into a flat string before populating `ChatResult.content`.
       */
      content: string | null | AnthropicContentBlock | AnthropicContentBlock[];
      tool_calls?: OpenAIToolCallWire[];
      /**
       * NON-STANDARD reasoning-model extension (Ollama Nemotron, Qwen-QwQ,
       * DeepSeek-R1 style). Populated when the model emits chain-of-thought;
       * used as a last-resort fallback for `content` when the model reasons
       * until the token budget cap and leaves `content` empty with
       * `finish_reason: "length"`. See mapper below for fallback rules.
       */
      reasoning?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /**
     * NON-STANDARD LiteLLM extension. Plain OpenAI-compat backends (Exo,
     * Ollama, vLLM, Workers AI) do NOT emit this; LiteLLM proxy + the
     * Phase 7 mock fixture (apps/example/fixtures/mock-openai-server.ts) DO.
     * Propagated through to `ChatResult.usage.costUsd` when present.
     */
    cost_usd?: number;
  };
}

/**
 * Translate an OpenAI Chat Completion JSON response into the kernel ChatResult.
 *
 * Throws `LLMClientProtocolError` when the response shape is malformed
 * (missing or empty `choices` array, missing `message`).
 */
export function mapOpenAIResponseToChatResult(raw: unknown): ChatResult {
  if (!raw || typeof raw !== 'object') {
    throw new LLMClientProtocolError('response is not an object', raw);
  }
  const r = raw as OpenAIChatCompletion;
  if (!Array.isArray(r.choices) || r.choices.length === 0) {
    throw new LLMClientProtocolError('response is missing choices array', raw);
  }
  const choice = r.choices[0];
  if (!choice || !choice.message) {
    throw new LLMClientProtocolError('response choice is missing message', raw);
  }

  const toolCalls = fromOpenAIToolCalls(choice.message.tool_calls);

  // Reasoning-field fallback: when a reasoning model (Nemotron, Qwen-QwQ,
  // DeepSeek-R1 style) exhausts its token budget mid-thought, plain-OpenAI
  // backends emit `content: ""` and stash the chain-of-thought in
  // `message.reasoning`. Surface that as content SO LONG AS there are no
  // tool_calls — an assistant-with-tool_calls turn must keep empty content
  // to preserve wire-format semantics on the next turn.
  const content = normalizeContent(choice.message.content);
  const reasoning = choice.message.reasoning;
  const reasoningFallback =
    content === '' && toolCalls === undefined && typeof reasoning === 'string' && reasoning !== ''
      ? reasoning
      : null;

  const result: ChatResult = {
    content: reasoningFallback ?? content,
  };

  if (toolCalls !== undefined) result.tool_calls = toolCalls;

  const usage = mapUsage(r.usage);
  if (usage !== undefined) result.usage = usage;

  const stopReason = mapFinishReason(choice.finish_reason ?? undefined);
  if (stopReason !== undefined) result.stopReason = stopReason;

  return result;
}

/**
 * Coerce wire-format `message.content` into a flat string.
 *
 * Handles four shapes the mapper has observed in the wild:
 * - `string` → returned as-is
 * - `null` / `undefined` → `''`
 * - single `{type:'text', text:string}` block → that text
 * - array of blocks → concatenated `text` from `{type:'text'}` entries (other
 *   block types like `tool_use` are dropped — they are surfaced separately via
 *   `message.tool_calls` by the Anthropic-via-LiteLLM passthrough)
 *
 * Anything else (numbers, foreign objects, blocks with non-string `text`) is
 * dropped rather than coerced — the kernel's `ChatResult.content: string`
 * contract demands a real string, and silent string-coercion of objects
 * (`"[object Object]"`) would corrupt traces and downstream prompts.
 */
function extractBlockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== 'text') return '';
  return typeof b.text === 'string' ? b.text : '';
}

function normalizeContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractBlockText).join('');
  if (typeof content === 'object') return extractBlockText(content);
  return '';
}

/**
 * Translate OpenAI usage object to kernel usage shape (D-12 + Plan 07-04 ext).
 *
 * - `prompt_tokens` → `inputTokens`
 * - `completion_tokens` → `outputTokens`
 * - `cost_usd` (LiteLLM-style non-standard ext) → `costUsd` when present;
 *   plain Exo / Ollama / vLLM / Workers AI omit this and `costUsd` stays
 *   undefined. Per Phase 3 D-16 the kernel never derives cost from tokens —
 *   backend-reported only.
 *
 * Returns undefined when input is undefined or yields an empty result.
 */
export function mapUsage(
  raw: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number } | undefined,
): ChatResult['usage'] {
  if (!raw) return undefined;
  const out: NonNullable<ChatResult['usage']> = {};
  if (typeof raw.prompt_tokens === 'number') out.inputTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') out.outputTokens = raw.completion_tokens;
  // LiteLLM-style cost_usd extension propagation (Plan 07-04 SC1+SC2 unblock):
  // mock fixture (apps/example/fixtures/mock-openai-server.ts) emits cost_usd
  // on every response so RunBudget.cumulativeCostUsd accumulates; LiteLLM
  // proxy emits it in production. Plain backends omit it → costUsd undefined.
  if (typeof raw.cost_usd === 'number') out.costUsd = raw.cost_usd;
  return Object.keys(out).length > 0 ? out : undefined;
}
