# Harness lessons — what the kernel experiment taught us

**Date:** 2026-04-26
**Subject:** Distill the failure modes observed in `agent-runtime` + `homelab-orchestrator` + the chat-server experiments into substrate-design implications. Source material: `homelab-orchestrator/docs/HARNESS-NOTES-2026-04-26.md` and the chat-server commit history (refusal detection, synthesis vacuity, F1/F2/F3 detectors).

---

## 1. The five failure modes the harness saw

In order of subtlety. All five were observed against real workloads driving Llama-4-Scout-17B via the Cloudflare AI Gateway compat endpoint, against an orchestrator agent with a tool surface that included `web_search`, `fetch_url`, `delegate_to_agent`, `create_agent`, `list_agents`, `today`. None of these are detectable by standard token-cost telemetry.

### 1.1 Synthesis vacuity

Tools fired correctly. Sub-agent produced material. Final assistant message *narrates the process* instead of *delivering the content*. Example: `"I've created a businessanalyst agent, delivered the summary and gap analysis. This is the final answer. No further action needed."` — 42 output tokens, no actual deliverable.

**Detection that worked:** when `stop_reason=end_turn` follows tool-use iterations whose outputs were non-empty, and the final assistant message is short AND lacks tool-output keyword overlap, flag `low_yield_synthesis`.

**Substrate implication:** run-end middleware in `@kagent/agent-loop` runs this detector AND can refuse to mark the AgentTask `completed` — instead status = `synthesized_vacuously`, payload includes the heuristic decision trail.

### 1.2 Sub-agent refusals masquerading as success

`delegate_to_agent` returned `status: "completed"` with `final_answer: "Your input is not sufficient. Please provide more details or specify the task you need help with."` — 19 output tokens, 0 tool calls in the sub-run. The sub-agent *refused* but the parent received it as a normal answer and synthesized over it.

**Detection that worked:** `detectRefusal(finalAnswer, toolCalls)` after a sub-run completes; if it matches refusal patterns AND the sub-run had no tool calls, the tool returns `ToolResult{isError: true, content: "{error: 'sub_agent_refused', refusal_reason, hint, ...}"}`. Parent LLM gets a structured `error: sub_agent_refused` envelope with a hint to re-delegate with the original request verbatim or admit failure to the operator — explicitly NOT to synthesize from training data.

**Substrate implication:** the A2A message envelope MUST include both the sub-agent's nominal status AND the substrate's structural verdict (`{ok: true, suspicious: 'refusal'}`). Parent agents see the substrate verdict; the substrate is opinionated about masquerading-as-success.

### 1.3 F1 — methodology fabrication

User: *"Cite a source URL you actually fetched."* `web_search` fired (snippet results). `fetch_url` did NOT fire. Final message: *"The source URL I fetched was https://oneuptime.com/blog/post/..."* — the conclusion is correct, but the claim *I fetched* is false. The model only saw the snippet.

**Detection:** scan the final message for verbs of action (`I fetched`, `I read`, `I downloaded`, `I called`, `I ran`) and verify the corresponding tool actually appeared in the trace's `tool_call` list. Mismatch → flag `methodology_fabrication`.

**Substrate implication:** middleware in `@kagent/agent-loop` ships the verb-vs-tool heuristic as a default, configurable per Agent CRD.

### 1.4 F2 — tool-use omission

User: *"Use a research specialist for the second part. Cite real URLs."* Trace: 2× parallel `list_agents`, then `stop=end_turn`. **Zero URLs in output.** No `delegate_to_agent` despite the explicit directive. No `web_search` despite the explicit directive. Model bypassed tools and fabricated from pretraining.

**Detection:** scan user prompt at run-start for trigger phrases (`cite real URLs`, `fetch the page`, `use a [X] specialist`, `search the web`) → derive an *expected-tool-list*. At run-end, verify the corresponding tool category fired. Missing → flag `tool_use_omission`.

**Substrate implication:** the AgentTask CRD optionally carries an `expectedTools` field; the substrate writes the F2 verdict alongside the result. This becomes a Langfuse-replayable signal across many runs.

### 1.5 F3 — truncated synthesis

User: *"Run this Python: `print(sum(i*i for i in range(1, 21)))`. If you can't actually execute code, say so plainly."* Trace: 1 LLM call, 0 tool calls, output cut at 256 tokens, `stop=end_turn` (NOT `length`). Content: *"... \frac{20(20+1)(2*"* — cut off mid-formula. No deliverable.

The CF Gateway compat layer reports `stop_reason: end_turn` even when the output is actually truncated by `max_tokens`. This is a provider-level inconsistency (the OpenAI spec is clear: `stop_reason: length` for max_tokens hits).

**Detection:** if `output_tokens_est` is at or near the configured `max_tokens` cap AND content does not end with sentence-terminating punctuation (`.`, `!`, `?`, `\n` followed by EOF, markdown link/list close), flag `truncated_synthesis` — structural check independent of the provider's `stop_reason` claim.

**Substrate implication:** middleware ships F3 as the canonical "provider-bug-resilient" detector. Token cap heuristics are configurable.

## 2. Cross-cutting lesson — model tier dominates everything

Three runs against Llama-4-Scout via CF gateway compat produced three different shapes: structured tool-calls + vacuous synthesis (1.1), structured tool-calls + real synthesis, JSON-as-text with no tool calls. **The same orchestrator code, the same prompt, three failure modes — the variable was the model.**

The empirical conclusion from the harness: **most "framework bugs" in the agent-platform space are model-tier bugs in disguise.** Llama-4-Scout-17B (a fast, cheap MoE) is not consistently capable of OpenAI tool-call protocol on the workloads we threw at it. Sonnet 4.6 via Bedrock or Llama-3.3-70B-Instruct via any backend handle the same workloads cleanly.

**Substrate implication:** kagent must make model choice a first-class, runtime-overridable parameter. Per-AgentTask model override, per-capability model defaults, per-tenant model policy — these are gateway-layer concerns (LiteLLM) but the operator must surface them on the CRDs. The substrate cannot save bad models from themselves; the substrate CAN make routing to good models the path of least resistance.

## 3. Cross-cutting lesson — anti-narration prompts work, partially

A system-prompt addition — *"Do NOT write tool-call JSON as your assistant content. Either invoke the tool through the function-call channel or write the answer."* — softened the JSON-as-text drift on Llama-Scout. It did not eliminate it.

**Substrate implication:** prompt hardening is a real lever, but it is a workload-layer concern (Agent CRD's `systemPrompt`), not a substrate concern. The substrate provides observation (does the assistant content contain tool-call shapes? — surface as `text_tool_call_attempted`), not enforcement.

## 4. Cross-cutting lesson — task distillation drops context

The orchestrator agent's `delegate_to_agent(task: "...")` argument compresses the operator's request, dropping context the sub-agent needs. Pattern: pass the operator's original message verbatim alongside the orchestrator's distillation, not just the distillation. Sub-agents on thin prompts decline ("not enough context").

**Substrate implication:** the A2A envelope between agents has a *required* field for the originating user message and a *recommended* field for parent-agent distillation. Both arrive at the sub-agent. The substrate enforces the protocol; framework choice does not bypass it.

## 5. The detector list, ported forward

These ship as middleware in `@kagent/agent-loop` as default-on, per-Agent-CRD-configurable run-end heuristics:

| Detector | Trigger | Disposition |
|---|---|---|
| `low_yield_synthesis` | end_turn after non-empty tool outputs, short final, no token overlap | flag in trace; AgentTask status = `synthesized_vacuously` |
| `sub_agent_refused` | sub-run final matches refusal patterns + 0 tool calls | A2A envelope marks `suspicious: refusal`; parent receives structured error |
| `methodology_fabrication` | final message contains verb-of-action whose tool didn't fire | flag in trace; warning in result |
| `tool_use_omission` | user prompt requested a tool category that didn't fire | flag in trace; warning in result |
| `truncated_synthesis` | output near max_tokens + content lacks clean ending | flag in trace; AgentTask status = `truncated` |
| `text_tool_call_attempted` | assistant content contains `{"name":"...","parameters":...}` shape | observation only; informs prompt-hardening |

Each emits as a Langfuse trace event. Aggregated across runs, they become operational dashboards: "what % of runs had F2 last week?" — a metric worth optimizing.

## 6. What this means for v0.1 architecture

Two concrete shapes the substrate ships because of these lessons:

1. **A2A envelope is opinionated, not transparent.** Every A2A message carries `(taskId, parentTaskId?, originalUserMessage, parentDistillation?, expectedTools?, structuralVerdict)`. The substrate writes `structuralVerdict` based on the detector heuristics. Parents and operators both see it.

2. **Run-end middleware is part of `@kagent/agent-loop`'s contract.** Every Agent pod runs the detector battery as its last step before publishing the result. Output of the loop is not just `{final_answer, trace}`; it's `{final_answer, trace, structuralVerdict, suspicious[]}`. Operators can choose to re-run on `suspicious: ['refusal'|'truncated'|...]`, escalate to a different model, or surface to a human.

These are the two specific places where the substrate is opinionated about what failure looks like. Everywhere else (loop logic, tool dispatch, model choice, prompt content) the substrate is agnostic — that's the application layer's job.
