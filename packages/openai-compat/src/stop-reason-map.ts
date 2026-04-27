/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * OpenAI `finish_reason` → kernel `ChatResult.stopReason` normalization (D-12).
 *
 * Pure mapping per D-12; no I/O, no fetch, no provider SDK names. The kernel's
 * `ChatResult.stopReason` union is exactly 4 values: `'end_turn' | 'tool_use'
 * | 'max_tokens' | 'stop_sequence'`. Unknown / unmapped values return undefined;
 * the executor treats undefined as `'end_turn'` per Phase 3 `executor.ts:330-331`.
 *
 * `content_filter` maps to `'end_turn'` per RESEARCH §Code Examples planner-decision —
 * preserves the Phase 3 union; matches OpenAI's UX that content_filter is still
 * a normal completion. Future consumer that needs to distinguish can layer
 * detection on top of `LLMClientProtocolError` or future trace metadata.
 */

import type { ChatResult } from '@kagent/agent-loop';

/** OpenAI Chat Completions API `choices[i].finish_reason` value union. */
export type OpenAIFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'function_call' // legacy alias for tool_calls
  | 'content_filter'
  | null;

/**
 * Translate an OpenAI `finish_reason` to the kernel's normalized `stopReason`.
 *
 * Returns `undefined` for `null`, `undefined`, and any value not in the
 * known table — forward-compat: new OpenAI values added by upstream don't
 * break the adapter; the executor's "undefined treated as end_turn" path
 * (executor.ts:330-331) takes over.
 */
export function mapFinishReason(finishReason: string | null | undefined): ChatResult['stopReason'] {
  if (finishReason === null || finishReason === undefined) return undefined;
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'function_call':
      return 'tool_use'; // legacy → new
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'end_turn'; // per RESEARCH planner-decision
    default:
      return undefined; // forward-compat: unknown values
  }
}
