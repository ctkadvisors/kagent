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
 *
 * --- Locale assumption (audit-rev2 C2 §1 L10) ---
 *
 * The phrase set is **English-only**. Llama-3 / Llama-4 / GPT-4 /
 * Claude all default to English-language refusals when given an
 * English prompt; the homelab cluster's prompts are all English
 * today. A run with a non-English system prompt or a model fine-
 * tuned for a non-English locale (e.g. an LM-Studio Mistral-fr
 * instance) WILL miss its refusal phrases — the detector returns
 * `null` and the parent LLM synthesizes over a refusal masquerading
 * as success. That is the same failure mode the detector exists to
 * prevent, only re-surfaced for non-English deployments.
 *
 * TODO(v0.2+): per-locale phrase sets keyed off
 * `Agent.spec.locale` or a detected language-of-final-answer
 * heuristic. Out of scope for v0.1 — locking down the English
 * homelab pilot is the priority. When this is revisited, consider
 * whether the detector should fire on the LANGUAGE-MISMATCH case
 * itself ("agent finalized in a locale outside its declared set")
 * as a structural-verdict signal independent of phrase matching.
 */
export function detectRefusal(finalAnswer: string, toolCalls: number): string | null {
  if (toolCalls > 0) return null;
  if (finalAnswer.length === 0 || finalAnswer.length >= 200) return null;
  const lc = finalAnswer.toLowerCase();
  // English-only phrase set; see locale-assumption note in the JSDoc
  // above. Adding a language other than English without a
  // corresponding test fixture set is a regression — the detector's
  // contract is "matches a refusal phrase OR returns null", not
  // "may match in any locale".
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
