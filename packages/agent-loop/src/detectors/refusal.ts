/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Heuristic refusal detector for sub-agent final answers.
 *
 * Lifted from homelab-orchestrator/src/chat/delegate-tool.ts. Catches
 * the Llama-Scout-style "Your input is incomplete. Please provide more
 * details" failure mode where a sub-agent terminates after one LLM call
 * with no tool use and a short content-free reply. Returning the matched
 * phrase lets the wrapper surface the reason structurally.
 *
 * Fires only when ALL hold:
 *   - 0 tool calls in the sub-run (sub-agent didn't even try).
 *   - final_answer length < 200 chars (no real content delivered).
 *   - final_answer matches a known refusal phrase (case-insensitive).
 *
 * Returns the matched phrase, or null if not a refusal. Consumers
 * (typically `delegate_to_agent`-flavored tools) wrap the verdict into
 * a `ToolResult{isError:true, content: { error: 'sub_agent_refused', ... }}`
 * envelope so the parent LLM sees the structural failure instead of
 * synthesizing over a refusal masquerading as success.
 */
export function detectRefusal(finalAnswer: string, toolCalls: number): string | null {
  if (toolCalls > 0) return null;
  if (finalAnswer.length === 0 || finalAnswer.length >= 200) return null;
  const lc = finalAnswer.toLowerCase();
  const phrases = [
    'input is incomplete',
    'input is not sufficient',
    'input is insufficient',
    'please provide more details',
    'please provide further details',
    'specify the task',
    'i need more information',
    'i need more context',
    'i don’t have enough',
    "i don't have enough",
    'cannot complete this',
    'unable to complete',
  ];
  for (const p of phrases) {
    if (lc.includes(p)) return p;
  }
  return null;
}
