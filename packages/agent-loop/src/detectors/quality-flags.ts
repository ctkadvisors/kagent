/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Run-end quality-flag detectors — pure heuristics over the trace, no
 * second LLM call. Lifted from homelab-orchestrator/src/chat/server.ts
 * (the chat-server harness where these earned their keep against
 * Llama-Scout via Cloudflare AI Gateway). See docs/HARNESS-LESSONS.md
 * for the failure modes each detector targets.
 *
 *   1. synthesis_low_yield — delegated/tooled work but final message
 *      drops the substantive content.
 *   2. methodology_fabrication — model claims a tool action ("I fetched",
 *      "I read") that didn't actually appear in the trace.
 *   3. tool_use_omission — operator's prompt demanded a tool action ("cite
 *      a real URL", "use a research specialist") that didn't fire.
 *   4. truncated_synthesis — output_tokens hit the cap AND content doesn't
 *      end on sentence-terminating punctuation. Catches CF-gateway-compat
 *      reporting `stop_reason: end_turn` instead of `length`.
 */

import type { TraceEntry } from '../trace.js';

const TRUNCATION_MIN_OUTPUT_TOKENS = 200;
const TRUNCATION_MIN_CONTENT_LEN = 200;

/**
 * Run all four detectors against the trace + final assistant message +
 * originating user prompt. Returns an array of flag ids (possibly empty).
 *
 * Pure function; no I/O. Designed to run as run-end middleware inside
 * `@kagent/agent-loop`.
 */
export function computeQualityFlags(
  traces: TraceEntry[],
  finalContent: string | null,
  userPrompt: string,
): string[] {
  const flags: string[] = [];
  if (computeSynthesisLowYield(traces, finalContent)) flags.push('synthesis_low_yield');
  if (detectMethodologyFabrication(traces, finalContent)) flags.push('methodology_fabrication');
  if (detectToolUseOmission(traces, userPrompt)) flags.push('tool_use_omission');
  if (detectTruncatedSynthesis(traces, finalContent)) flags.push('truncated_synthesis');
  return flags;
}

/**
 * Methodology fabrication — the model claims it took a tool action that
 * the trace does not corroborate. Pattern: final message contains a verb
 * of action ("I fetched", "I read", "I downloaded", "I ran", "I executed")
 * but the corresponding tool category is absent from the trace's
 * successful tool_call list. Conservative — only flags clear past-tense
 * first-person claims ("I X-ed" or "I have X-ed").
 */
function detectMethodologyFabrication(traces: TraceEntry[], finalContent: string | null): boolean {
  if (!finalContent || finalContent.length === 0) return false;
  const lc = finalContent.toLowerCase();

  const successfulToolNames = new Set(
    traces
      .filter((t) => t.trace_type === 'tool_call' && t.is_error !== true)
      .map((t) => (t.tool_name ?? '').toLowerCase()),
  );

  type Claim = { regex: RegExp; requiredTool: string[] };
  const claims: Claim[] = [
    {
      regex:
        /\bi (?:have )?(?:fetched|downloaded|loaded|opened|visited|navigated to|scraped|crawled)\b/,
      requiredTool: ['fetch_url'],
    },
    {
      regex:
        /\bi (?:have )?(?:read|reviewed) the (?:page|article|site|blog|post|content|document)\b/,
      requiredTool: ['fetch_url'],
    },
    {
      regex:
        /\bi (?:have )?(?:ran|executed|computed|evaluated) (?:the|this) (?:code|script|program|command|python|sql)\b/,
      // No code-execution tool exists today; any such claim is a fabrication.
      requiredTool: ['__code_exec_unavailable__'],
    },
    {
      regex:
        /\bi (?:have )?(?:delegated to|asked|consulted) (?:the |a |an )?(?:[a-z]+ )?(?:specialist|researcher|analyst|agent)\b/,
      requiredTool: ['delegate_to_agent'],
    },
  ];

  for (const c of claims) {
    if (!c.regex.test(lc)) continue;
    const satisfied = c.requiredTool.some((t) => successfulToolNames.has(t));
    if (!satisfied) return true;
  }
  return false;
}

/**
 * Tool-use omission — the operator's prompt contains explicit imperatives
 * that demand a particular tool action, and the trace shows that tool
 * was never used (or only errored). Heuristic; conservative on triggers
 * to avoid false positives on prompts that incidentally mention "search"
 * in a different sense.
 */
function detectToolUseOmission(traces: TraceEntry[], userPrompt: string): boolean {
  if (!userPrompt || userPrompt.length === 0) return false;
  const lc = userPrompt.toLowerCase();

  const successfulToolNames = new Set(
    traces
      .filter((t) => t.trace_type === 'tool_call' && t.is_error !== true)
      .map((t) => (t.tool_name ?? '').toLowerCase()),
  );

  type Demand = { regex: RegExp; satisfiedBy: string[] };
  const demands: Demand[] = [
    {
      regex:
        /\bcite (?:a |the |real )?(?:source |reference )?url\b|\breal urls?\b|\bcite (?:real )?sources\b/,
      satisfiedBy: ['fetch_url', 'web_search'],
    },
    {
      regex:
        /\bfetch (?:the |this )?(?:page|url|content|html)\b|\bdownload (?:the |this )?(?:page|url)\b|\bscrape\b/,
      satisfiedBy: ['fetch_url'],
    },
    {
      regex: /\bsearch (?:the )?web\b|\bgoogle (?:for|it)\b|\blook (?:it )?up online\b/,
      satisfiedBy: ['web_search', 'fetch_url'],
    },
    {
      regex:
        /\buse (?:a |the |an )?(?:research|business|specialist) (?:agent|specialist|analyst)\b|\bdelegate (?:this |it )?to\b|\bask (?:the |a |your )?(?:research|business|specialist)/,
      satisfiedBy: ['delegate_to_agent'],
    },
  ];

  for (const d of demands) {
    if (!d.regex.test(lc)) continue;
    const satisfied = d.satisfiedBy.some((t) => successfulToolNames.has(t));
    if (!satisfied) return true;
  }
  return false;
}

/**
 * Truncated synthesis — final LLM call produced non-trivial output but
 * the content does not end on sentence-terminating punctuation. Catches
 * the CF-gateway-compat bug where `stop_reason: end_turn` is reported
 * even when output was capped by `max_tokens`. Independent of stop_reason
 * AND independent of the configured per-provider cap (which varies).
 *
 * Fires only when ALL hold:
 *   - Final assistant content >= TRUNCATION_MIN_CONTENT_LEN chars (so
 *     short conversational answers like "containerd." don't false-fire).
 *   - The last LLM call emitted >= TRUNCATION_MIN_OUTPUT_TOKENS estimated
 *     output tokens (so we're not flagging tiny model replies).
 *   - Content's last non-whitespace character is NOT a sentence terminator
 *     and NOT a closing fence character.
 */
function detectTruncatedSynthesis(traces: TraceEntry[], finalContent: string | null): boolean {
  if (!finalContent) return false;
  const trimmed = finalContent.trimEnd();
  if (trimmed.length < TRUNCATION_MIN_CONTENT_LEN) return false;

  const llmCalls = traces.filter((t) => t.trace_type === 'llm_call');
  const last = llmCalls[llmCalls.length - 1];
  if (!last) return false;
  const out = last.output_tokens_est ?? 0;
  if (out < TRUNCATION_MIN_OUTPUT_TOKENS) return false;

  // Sentence terminators + balanced closing fences. `)` and `]` are
  // accepted because long answers legitimately end on a markdown link
  // (`](url)`) or list close. Excluded: `*`, `"`, `` ` ``, `>` — those
  // tend to appear in unbalanced truncation cases (`(2*` mid-formula,
  // `**E` mid-bold) where there's no matching opener nearby to make it
  // unambiguously a clean end.
  const lastChar = trimmed.charAt(trimmed.length - 1);
  const cleanEnd = '.!?…)]'.includes(lastChar);
  return !cleanEnd;
}

/**
 * Synthesis low-yield — substantive tool/delegation work was done but
 * the final assistant message drops most of it. Two short-circuits and
 * a token-overlap fallback.
 */
function computeSynthesisLowYield(traces: TraceEntry[], finalContent: string | null): boolean {
  if (!finalContent || finalContent.length === 0) return false;

  // Short-circuit 1: if there were any delegate_to_agent calls and ALL of
  // them errored (e.g., sub-agent refusals), the orchestrator MUST NOT have
  // produced a substantive answer from delegated work. Any non-empty
  // synthesis at this point is either an admission of failure (fine, but
  // flag it for visibility) or a hallucination. Either way: flag.
  const delegations = traces.filter(
    (t) => t.trace_type === 'tool_call' && t.tool_name === 'delegate_to_agent',
  );
  if (delegations.length > 0 && delegations.every((t) => t.is_error === true)) {
    return true;
  }

  // Standard path — for direct-tool runs (web_search, fetch_url, etc.) where
  // the model's job is to surface the substantive content from the outputs.
  if (finalContent.length >= 400) return false;

  const toolOutputs = traces
    .filter((t) => t.trace_type === 'tool_call' && t.is_error !== true)
    .map((t) => t.tool_output ?? '')
    .filter((s) => s.length >= 200);
  if (toolOutputs.length === 0) return false;

  const fingerprint = (text: string): Set<string> => {
    const tokens = new Set<string>();
    // Strip likely JSON keys ("foo":) so structural noise doesn't dominate.
    const stripped = text.replace(/"[a-z_][a-zA-Z0-9_]{0,40}":/g, ' ');
    for (const m of stripped.toLowerCase().matchAll(/[a-z0-9]{6,}/g)) {
      tokens.add(m[0]);
    }
    return tokens;
  };

  const toolTokens = fingerprint(toolOutputs.join(' '));
  // Lowered floor from 25 → 8 so cases with sparse but real content
  // (refusals + a small successful tool call) still get evaluated.
  if (toolTokens.size < 8) return false;

  const finalTokens = fingerprint(finalContent);
  let overlap = 0;
  for (const tok of finalTokens) {
    if (toolTokens.has(tok)) overlap += 1;
  }
  const ratio = overlap / toolTokens.size;
  return ratio < 0.05;
}
