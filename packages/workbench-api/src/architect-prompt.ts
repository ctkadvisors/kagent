/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Architect system prompt + repair-turn builder. The Architect turns a
 * natural-language goal into a single AgentTemplate candidate (the
 * `application/x-kagent-template-candidate+yaml` artifact), which is then
 * validated by `@kagent/dto`'s `parseAgentTemplateSpec`. On validation
 * failure the route re-prompts with the error via `buildArchitectMessages`
 * carrying `priorYaml` + `validationError` (the self-correct loop).
 *
 * The contract taught here mirrors the real `AgentTemplateSpec` shape
 * (see packages/dto/src/template-candidate.ts + the candidate-template
 * fixture): `agentSpec` is required; budget is kept conservative by
 * default (paperclip rule).
 */

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export const REPAIR_PREFIX =
  'Your previous candidate failed validation. Fix ONLY the error below and return the full corrected YAML.';

const SYSTEM = `You are the kagent Architect. Turn the user's request into a single
AgentTemplate candidate, emitted as YAML and NOTHING else (no prose, no code fences).

The YAML MUST conform to the AgentTemplateSpec contract:
  agentSpec:                  # REQUIRED object — the agent body
    modelClass: string        # prefer "text-generator-default" unless tools are required
    # model: string           # optional escape hatch; use only for literal physical models
    systemPrompt: string      # the agent's behaviour; may use \${param.X} placeholders
    tools: [string]           # optional
    toolProfileRef: string    # optional; gateway-owned profile/agent type for rich tools
    llmParams:                # optional
      temperature: number
      maxTokens: integer
  templateVersion: 1          # optional, default 1
  parameters:                 # optional, non-empty array if present
    - name: string
      type: string|integer|toolSelection
      required: true|false
      default: string         # optional
  budget:                     # optional — KEEP CONSERVATIVE (paperclip rule)
    maxIterations: integer    # default 6, never exceed 10 unless asked
    maxCostUsdPerRun: number  # default 0.10, never exceed 0.50 unless asked
    maxParallelInstances: 1
  toolAllowlist: [string]     # optional; omit = no tools

Rules:
- Use agentSpec.modelClass, not agentSpec.model, for logical classes such as
  "text-generator-default", "tool-caller-default", or "reasoner-default".
- Default no-tool agents to modelClass: text-generator-default.
- Use modelClass: tool-caller-default only when tools are requested.
- Prefer toolProfileRef over raw browser.*, code_interpreter.*, mcp.*, or http.* tool lists when
  the requested tool surface matches a known gateway-owned agent type.
- Default budget to maxIterations 6, maxCostUsdPerRun 0.10, maxParallelInstances 1 unless the user is explicit.
- Never include credentials or tools the user did not ask for.
- Output ONLY the YAML document — no backticks, no commentary.`;

export interface ArchitectPromptInput {
  readonly userGoal: string;
  readonly priorYaml?: string;
  readonly validationError?: string;
}

/**
 * Build the message list for one Architect turn. First attempt = system +
 * user goal. Repair attempt (priorYaml + validationError both present) =
 * system + goal + the assistant's bad output + a repair instruction
 * carrying the validator error.
 */
export function buildArchitectMessages(input: ArchitectPromptInput): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: SYSTEM }];
  if (input.priorYaml !== undefined && input.validationError !== undefined) {
    msgs.push({ role: 'user', content: input.userGoal });
    msgs.push({ role: 'assistant', content: input.priorYaml });
    msgs.push({
      role: 'user',
      content: `${REPAIR_PREFIX}\n\nERROR: ${input.validationError}\n\nPREVIOUS YAML:\n${input.priorYaml}`,
    });
  } else {
    msgs.push({ role: 'user', content: input.userGoal });
  }
  return msgs;
}
