# Resilient Output Contracts

**Date:** 2026-05-05
**Status:** Design proposal, pre-implementation
**Owner / scope:** v0.2.x — substrate-level. No application-layer policy.

> Read [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) and `packages/agent-pod/src/runner.ts` first.
> This doc describes how the kagent **substrate** stays correct when the model
> deployed inside an agent pod fails to honor a structured-output request —
> across providers, across models, across the OpenAI-compat shims and the
> Cloudflare AI Gateway / LiteLLM proxy in front of them.

---

## 1. Problem statement

The substrate's job is to make a per-agent microVM, run its loop against an
LLM, and write a verifiable answer back to `AgentTask.status`. Every step in
that contract assumes the model will do what the system prompt asked. Our
RC-pilot evidence pack shows the model is the most likely thing to break.

Two specific failure modes were observed and are not the model's fault to
fix; they're the substrate's fault to absorb.

### 1.1 Verifier envelope mismatch

The agent-pod wraps every result in `{ content: "<text>" }`. See
`packages/agent-pod/src/status.ts:82` (`buildStatusPatch`):

```ts
result: { content: result.finalContent },
```

`result.finalContent` is the raw assistant string. When an Agent's prompt
asks for JSON (e.g. `{"answer":"K stands for Kubernetes."}`), the agent's
final assistant message **is** that JSON string verbatim. So
`AgentTask.status.result` ends up as:

```json
{ "content": "{\"answer\":\"K stands for Kubernetes.\"}" }
```

The substrate verifier (`packages/operator/src/verifier.ts:812`) then
substitutes the *whole envelope* into the LLM-judge prompt:

```ts
const resultJson = JSON.stringify(task.status?.result ?? null);
const renderedPrompt = renderLlmJudgePrompt(template, resultJson);
```

So the judge sees:

```
{"content":"{\"answer\":\"K stands for Kubernetes.\"}"}
```

…and is being asked to decide whether THAT matches the requested shape.
Two layers of wrapping. Embedded escaped quotes. The judge correctly says
"this is not the requested shape." Pass and fail scenarios are
indistinguishable to it.

### 1.2 Tool-call failures (small-model schema drift)

Scenarios `rc-pilot-delegation` and `rc-pilot-artifact-producer` failed
because the model `nemotron-3-nano:4b` literally typed:

```
spawn_child_task(task: "summarize the doc")
```

…as plaintext in the assistant message rather than emitting a structured
`tool_calls[]` entry. This is a known failure mode for smaller open
models — see the NVIDIA forum thread on
`llama-3.1-nemotron-nano-4b-v1.1` and the Ollama issue
[ollama#8287](https://github.com/ollama/ollama/issues/8287) on
`<toolcall>` text. Llama 3.2-8B and below do this often;
nemotron-nano-4B does it nearly every time when the request volume gets
above a couple of tools. The `system_prompt` is not a sufficient
mitigation — the model just doesn't follow it.

### 1.3 Why this matters at the substrate level

The CLAUDE.md design default is
`workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct` via Cloudflare AI
Gateway. That model is good, and we will wire it. But the substrate
must:

- accept that consumers will deploy small / quantized / open models
- accept that the model is the only component without a release lifecycle
  we control
- treat output-shape failure as a foreseeable, not-exceptional event
- expose the gates and adapters that absorb it as **kagent primitives**,
  not application code

If we don't do this, every consumer will reinvent the same five
patches against their own loop, and the substrate's "unified
observability + trustable verifier" pitch is hollow.

---

## 2. Pattern catalog

Seven production patterns. For each: how it works, what problem class
it solves, what it costs, how it composes with the others.

### (a) Provider-side constrained decoding

**How it works.** The inference engine compiles a JSON Schema (or
context-free grammar, or regex) into a token mask applied at every
sampling step. Tokens that would violate the grammar get their logits
masked to -∞. The model literally cannot emit invalid output because
the sampler refuses to draw it.

Reference implementations (Q1 2026):

| Engine                          | Mode                          | Enforced? |
|---------------------------------|-------------------------------|-----------|
| OpenAI                          | `response_format: json_schema` + `strict: true` | yes — CFG-constrained sampler |
| OpenAI                          | tool `function` + `strict: true` | yes — same engine |
| OpenAI                          | `response_format: json_object` | no — best-effort syntax only (now considered legacy) |
| Anthropic                       | `tool_use` + `strict: true`   | yes — grammar-constrained sampling |
| Anthropic                       | structured-outputs (preview)  | yes — same engine |
| Cloudflare workers-ai           | `response_format: { type: "json_schema", json_schema: {...} }` | yes — JSON-mode is OpenAI-compatible, grammar-backed |
| Ollama (≥ 0.5)                  | `format: <schema>`            | yes — derives a GBNF grammar per request |
| vLLM                            | `guided_json` / Outlines / XGrammar / llguidance | yes — engine plug-in |
| llama.cpp                       | `--grammar` + GBNF            | yes |
| LiteLLM proxy                   | passes `response_format` through to the backend | depends on backend (see above) |

Ollama's structured-outputs feature has a documented gotcha worth
naming: **the grammar prevents invalid tokens; it does not prevent
mid-generation truncation**. If the model hits its `max_tokens` halfway
through `{"answer":"`, the response is grammar-valid up to that point
but a JSON parser will reject it. This means even with constrained
decoding the consumer **still needs** a tolerant parser + retry tier.
The same is true of OpenAI / Anthropic with very small `max_tokens`,
though in practice their default ceilings make this rare.

**Problem class solved.**
- (a) Format-shape adherence at token-emission time — eliminates the
  `{"answer": "K"}` vs `K stands for Kubernetes.` distinction by making
  the schema a hard constraint.
- (a) Smaller-open-model tool-call drift — when `tools[]` is set with
  schemas, the constrained sampler will not emit a free-text
  `spawn_child_task(...)` call at all.

**Costs.**
- *Latency:* engines that compile grammars on-request (Outlines's
  pre-compiled-FSA path) have ~100ms grammar-compile startup the first
  time a schema is seen; XGrammar / llguidance amortize via cached
  compilations and contribute ~50µs/token. Modern proprietary
  endpoints (OpenAI/Anthropic/CF) bury this; you pay it only as
  request-cold-start, hidden in their TTFT budget.
- *Token:* zero direct cost. Indirect savings: no retry tokens.
- *Complexity:* schemas have to be derivable in TS at agent-pod boot.
  We already have Zod in the substrate. Cost is marginal.
- *Coverage:* not every model on every provider supports it. Older
  open models on Ollama (`tinyllama`, `nemotron-nano-4B` with the
  current ollama build, etc.) sometimes have grammar support that
  silently fails to constrain certain edge tokens.

**Composition.**
- Composes UPWARD with (b) retry — if the engine still produces something
  unusable (truncation, the schema-not-supported edge case), the retry
  loop catches it.
- Composes UPWARD with (c) tolerant parsers — even constrained outputs
  arrive with an outer model envelope that needs unwrapping.
- Substitutes for (e) tool-as-contract for the **format** problem;
  doesn't substitute for it for the **routing** problem (a JSON-shaped
  output still has to be interpreted as "this is the final answer" vs
  "this is intermediate"). Strict tool use solves both.

### (b) Retry-with-corrective-feedback loops

**How it works.** Parse the model output. On failure, append a new
user message containing the parser error verbatim, e.g.:

```
Your previous response failed validation:
  - At $.answer: expected string, got null

Please return ONLY the JSON object described in the schema, with no
prose, no code fences, and no commentary.
```

…and re-call. Caller-side iteration cap (typically 1–3).

**Problem class solved.**
- Last-mile format slips (trailing comma, unquoted key, prose preamble).
- Cases where a constrained-decoding engine isn't available.
- Refusals where the model can be coaxed back on track ("you said you
  cannot help — but the schema requires you to attempt; if you cannot,
  emit `{"answer": null, "decline_reason": "..."}`").

**Costs.**
- *Latency:* one extra round-trip per retry. In the agent-pod pattern
  this is ~1–3 sec on workers-ai, ~0.5–1.5 sec on a local Ollama, ~3–8
  sec on Bedrock under load.
- *Tokens:* the failed output's tokens are billed and discarded; the
  retry pays for re-prompting plus a second response. Empirically
  consumes 1.5–3× the baseline for the failure tier of traffic.
- *Convergence:* Instructor's published numbers (April 2026 docs) put
  baseline GPT-4o-class models at ~95% first-shot adherence in JSON
  mode, ~99.5% within one retry, ~99.9% within two. Llama-3-8B class
  drops to ~70% first-shot, ~92% one retry, ~97% two retries.
  Nemotron-nano-4B-class is the bottom tier — first-shot adherence
  on multi-tool schemas is closer to 30%.
- *Cap:* without a cap, malformed outputs from a stuck model can
  burn the per-task token budget on retries and time-out. Cap is a
  must. Recommended: **2 retries**, then fail with a structured
  `output_contract_violated` reason.

**Composition.**
- Mandatory complement to (a) for the engines that do best-effort,
  not strict, structured outputs.
- Composes with (c) — try tolerant parsing first, retry only if even
  the tolerant parser fails.
- Composes with (g) — schema validators emit the error string the
  retry message includes verbatim.

### (c) Tolerant parsers

**How it works.** When the model emits *almost*-JSON, a tolerant
parser tries progressively more permissive recovery strategies before
giving up:

1. Strict `JSON.parse`.
2. Strip a leading code fence (```` ```json ... ``` ````).
3. Extract the first balanced-brace JSON-shaped substring (regex +
   bracket-balance).
4. Apply common-error repair: trailing commas, unquoted keys, single
   quotes, smart-quote normalization.
5. Try `JSON5` / `dirty-json` / `json5-strict` parser.
6. Try a partial-JSON parser for streaming truncation
   (`partial-json-parser`).
7. Last-resort: ask another LLM to repair the JSON (Instructor's
   "repair pass") — slow and expensive; we DO NOT recommend this at
   substrate level.

**Problem class solved.**
- Models that wrap JSON in ```` ```json ```` fences when the prompt
  asked them not to (Llama 3.x and Llama 4 do this >50% of the time).
- Models that emit "Sure! Here's the JSON: { ... }" prose preambles.
- Mid-generation truncation that leaves valid-looking-but-incomplete
  JSON.
- Single-quoted keys (Mistral lineage).
- Trailing commas after the last element (most open-source models).

**Costs.**
- *Latency:* sub-millisecond. No round trip.
- *Tokens:* zero.
- *Complexity:* low — a single 50-line module per project. Library
  options:
  - `dirty-json` — npm, MIT, mature.
  - `json5` — npm, MIT, mature, adds a new spec dependency.
  - Hand-rolled brace-balanced extractor — what `parseVerifierJudgeReply`
    in `packages/operator/src/verifier.ts:337` already does for the
    LLM-judge response (strips a single pair of fences). That logic is
    half the answer; the other half is the brace-balanced first-JSON
    extractor.

**Risks.**
- A tolerant parser will **silently accept** a wider input space than
  the schema. If the schema validator (g) is not run *after* the
  tolerant parse, type errors land in `status.result` and the next
  hop discovers them. So: tolerant parsers only useful as a *parsing*
  step, never as a *trust* step.

**Composition.**
- Layer between raw model output and (g) schema validation.
- Reduces the trigger rate on (b) retry — many slips are repairable
  in-process.
- Replaces ~no other layer; it shrinks (b)'s workload, doesn't
  remove it.

### (d) Envelope-aware verifier prompts / system-prompt scaffolds

**How it works.** Two complementary moves:

**(d1) Substrate-side: teach the verifier to unwrap before judging.**
Instead of `JSON.stringify(task.status.result)` raw, the verifier
extracts the *answer payload* from the substrate envelope and renders
THAT into the prompt. Two flavors:

- *Naive unwrap.* If `status.result` has a single `content` key, render
  `result.content`. (Solves §1.1 verbatim.)
- *Structured unwrap.* If `status.result.structured` is set (a future
  CRD field, see §4), render that. Else render `status.result.text`.
  Else render `JSON.stringify(status.result)` for back-compat.

**(d2) Agent-side: teach the agent to put the structured part in a
known location.** Two flavors here too:

- *Codeblock convention.* The system prompt says "emit your final
  answer inside a ```` ```kagent-output ```` codeblock." The substrate
  extracts that block and treats its body as the structured answer.
  Cheap; works on any model. Useful when constrained decoding isn't
  available.
- *Tool-as-submitter.* The agent is given a `submit_answer(...)`
  tool whose schema IS the output contract. The model never emits the
  answer in chat text at all; it emits a tool call. (This is pattern
  (e) — see below.)

**Problem class solved.**
- §1.1 directly: removes the wrapping layer from the verifier's view.
- Disambiguates "the model rambled THEN gave the answer" from "the
  model gave only the answer" — both end up wrapped identically once
  the codeblock is extracted.

**Costs.**
- *Latency:* zero.
- *Tokens:* the codeblock-convention path adds ~30 tokens to the
  system prompt. Substrate-side unwrap is free.
- *Complexity:* low. ~50 lines in `verifier.ts` for the unwrap;
  ~20 lines in `runner.ts` for the codeblock extractor.

**Composition.**
- Required complement to almost everything else — until the
  envelope is clarified, all the other layers are typing the same
  string two different ways.
- Composes with (e): when (e) is on, (d2) is essentially mandatory
  because the model emits no chat content at all.
- Composes with (a): even with constrained decoding, the agent-pod
  still wraps in `{content: ...}`; the verifier still needs to
  unwrap.

### (e) Function/tool calling as first-class contract

**How it works.** Instead of asking the model "emit your answer as
JSON in your reply text," wire the structured answer as a tool the
model is *required* to call:

```ts
const submit_answer = {
  name: "submit_answer",
  description: "Emit your final answer in the structured form required by the task.",
  input_schema: {
    type: "object",
    required: ["answer"],
    properties: {
      answer: { type: "string", description: "..." },
      // ... other contract fields
    },
  },
};
```

The agent-pod runs the loop with `tool_choice: { type: "tool", name:
"submit_answer" }` (or the equivalent forced-tool-use directive on the
provider) and treats the tool-call arguments as the answer. Final
chat text is ignored or stored separately.

**Why this beats free-text JSON.** The model is much better at
filling argument schemas than producing JSON inside chat text. Three
reasons:

1. Tool-use is in the post-training data far more often than "emit
   JSON in chat" is. SFT/RLHF rounds reward correct tool-call schema
   adherence; they don't reward correct chat-JSON.
2. With strict tool use (see (a)), the schema is enforced at the
   sampler. With chat-JSON the schema is a wish.
3. The model has a clear "emit done" signal — the moment the tool
   call is closed, the model exits. With chat-JSON, the model often
   keeps generating prose ("Hope this helps!") that the tolerant
   parser then has to chop off.

**Provider/model support (Q1 2026).**

| Backend                                           | Tool use   | Forced tool | Strict args |
|---------------------------------------------------|------------|-------------|-------------|
| OpenAI gpt-4o / gpt-4.1 / gpt-5                   | yes        | yes         | yes         |
| Anthropic claude-sonnet-4-5+ / claude-opus-4-7    | yes        | yes         | yes         |
| Cloudflare workers-ai (Llama 3.3 70B, Llama 4 Scout) | yes     | partial     | partial — schema is a hint |
| AWS Bedrock Claude (any)                          | yes        | yes         | yes         |
| Ollama Llama 3.3 70B                              | yes        | yes         | partial     |
| Ollama Llama 3.1 8B / 3.2 3B                      | unreliable | unreliable  | unreliable  |
| Ollama nemotron-nano-4B                           | broken — emits as plaintext | n/a | n/a |
| vLLM + Outlines / XGrammar                        | yes        | yes         | yes         |
| LiteLLM proxy                                     | passes through to backend | passes through | passes through |

Empirically: `tools[]` + `tool_choice: required` + `strict: true`
*solves* §1.2 on every provider where the row's "Strict args" is
`yes`. For workers-ai with Llama 4 Scout, the partial-strict
behavior plus a tolerant parse on the tool-arguments string covers
~98% of cases.

**Problem class solved.**
- §1.2 directly.
- Auto-solves §1.1 because the answer is in `tool_calls[0].arguments`,
  not in chat content. The substrate envelope writes the parsed args
  to `result.structured` (see §4) and the verifier never sees a
  double-wrapped string.

**Costs.**
- *Latency:* zero relative to chat. (One backend round-trip either way.)
- *Tokens:* tool definitions add ~100–200 tokens per call. With
  prompt caching this is amortized.
- *Complexity:* the agent-loop has to special-case the
  "submit_answer was called" exit condition. ~30 lines.

**Composition.**
- This is the **strongest** single move. Use it whenever the backend
  supports it.
- Composes UPWARD with (a) — tool-use IS a constrained-decoding
  application; turning on `strict` is just a flag.
- Composes with (d2) — when (e) is on, (d2)'s codeblock path is
  unnecessary (the structured answer is in `tool_calls`, not chat).
- Composes with (g) — Zod-validate the parsed `arguments` after the
  fact even if the backend claims `strict`.

### (f) Mismatch detection at the verifier (vacuous outputs)

The substrate's verifier today checks "format" via
`parseVerifierJudgeReply` (`packages/operator/src/verifier.ts:337`).
But there's a class of failure that's format-correct and yet
content-vacuous:

- *Refusal:* `{"answer": "I cannot help with that."}` — schema-valid,
  content-empty.
- *Performative-success:* `{"answer": "Sure! Here's the answer."}` —
  schema-valid, content-empty.
- *Hedge-only:* `{"answer": "It depends on context."}` —
  schema-valid, content non-functional.

What we already have in `packages/agent-loop/src/detectors/`:

- `detectRefusal` (`refusal.ts:26`) — fires when 0 tool calls AND
  final_answer < 200 chars AND matches a known phrase ("input is
  incomplete", "please provide more details", etc.). Returns the
  matched phrase or null. This is structurally good. **The phrase
  set is ENGLISH-ONLY** (audit-rev2 C2 §1 L10) — agents running with
  non-English system prompts or non-English fine-tunes will miss
  their refusal phrases and silently slip through. Per-locale phrase
  sets are tracked as a v0.2+ TODO in `refusal.ts`'s JSDoc; the v0.1
  homelab pilot is English-only by design.
- `computeQualityFlags` (`quality-flags.ts`) — emits four flag ids:
  - `synthesis_low_yield` — substantive tool work was done but the
    final message dropped most of it.
  - `methodology_fabrication` — model claims a tool action that the
    trace doesn't corroborate.
  - `tool_use_omission` — operator's prompt demanded a tool action;
    the trace shows none.
  - `truncated_synthesis` — output_tokens hit the cap and the content
    doesn't end on sentence-terminating punctuation.

These already write into `AgentTask.status.structuralVerdict.suspicious`
(`packages/agent-pod/src/status.ts:71`).

**Gap.** The detectors operate on the trace. The substrate-level
`verifyContract` operates on `status.result`. The two paths don't
talk to each other:

1. The verifier never reads `structuralVerdict.suspicious`.
2. The detectors never look at the *requested* output schema (so
   they can't flag "the schema demanded a non-empty `answer` field
   and the field is empty / vacuous").

**What to add (not "redo what exists").** A small bridge:

- The verifier's pre-check looks at `status.structuralVerdict.suspicious`
  before dispatching. If `refusal` (a new flag, see below) is in the
  list, fail with `verdict:fail: refusal_detected` and skip the
  judge round-trip.
- A new detector `vacuous_output` that fires when the structured
  output's fields are present-but-empty (`answer`-shaped fields
  that match `/^(sure|here|i ?cannot|i ?am unable|...)/i`). Lifted
  from refusal.ts's phrase list, applied to the *parsed structured
  field*, not the chat content.
- An `Agent.spec.outputContract.minLength` knob (see §4) so the
  detector knows what "vacuous" means for THIS contract. Optional;
  default is "fire only on phrase-match."

**Problem class solved.**
- The class of "model returned shape-perfect JSON but the JSON's
  contents are not an answer" — the most expensive failure mode
  because it eats LLM-judge tokens to discover.

**Costs.**
- *Latency:* zero — the detector pass already runs.
- *Tokens:* zero. Saves verifier-judge tokens by short-circuiting.
- *Complexity:* +60 lines of detector + +20 lines of bridge in
  `verifier.ts`.

**Composition.**
- Composes with (g) — schema validation finds shape-empty;
  vacuous-detection finds content-empty.
- Reduces (b)'s workload — vacuous outputs don't get retried (a
  retry that re-asks the same question is unlikely to escape the
  same vacuity), they fail immediately with a clear reason.

### (g) Schema-hardening at boundaries

**How it works.** Run a runtime validator (Zod / Valibot / TypeBox)
at every CRD-status / tool-input / tool-output boundary. Two layers:

**(g1) Inbound: validate before trust.**
Every input the substrate receives from the model is validated
against a schema before being threaded onward. The validator's
output is a tagged union: `{ ok: true, value }` or
`{ ok: false, errors: [...] }`. Errors carry a JSON Pointer-shaped
path so the retry message can be specific.

**(g2) Outbound: validate before write.**
Every output the substrate writes to `AgentTask.status` (or to
NATS, or to Langfuse) is validated against the same schema. This
catches bugs in the substrate's own envelope manipulation, e.g.
"the runner accidentally wrote `result.text` as `null` because of
an upstream error."

**Library options for kagent.**
- *Zod.* npm-mature, MIT, ~10kb. Has `zod-to-json-schema` for
  emitting OpenAI strict-mode schemas. We already use Zod elsewhere
  in `@kagent/capability-types`. **Recommended.**
- *Valibot.* Smaller bundle (~2kb tree-shaken), faster, but less
  ecosystem.
- *TypeBox.* Schema-first (define JSON Schema, derive TS); good fit
  if a substrate-author wants to write JSON Schema directly. Not the
  TS-first model the rest of the codebase uses.

**Failure modes.**
- *Reject and retry.* The default — when validation fails on
  model output, append the validation errors to the retry message
  (pattern (b)).
- *Log and degrade.* Required for outbound-validation failures —
  if the substrate's own write fails validation, we log + emit an
  audit event but DON'T crash the pod. The agent-loop already
  exited; we cannot retry.

**Problem class solved.**
- The "field exists but is the wrong type" class — a common failure
  mode of best-effort JSON modes (Cloudflare workers-ai today
  occasionally emits `{ "count": "5" }` when the schema says
  `"count": number`).
- Catches drift between the schema declared on the Agent and what
  the model actually emits.

**Costs.**
- *Latency:* sub-millisecond per validation.
- *Tokens:* zero direct. Indirect: shrinks (b)'s retry rate.
- *Complexity:* low. Each contract field is a Zod schema; the
  agent-pod's runner.ts already imports the openai-compat Zod helper.

**Composition.**
- Mandatory layer for any pattern. Without (g), nothing else can
  be trusted.
- Composes with (a) — even with strict structured outputs, ALWAYS
  validate (the `strict: true` flag is provider-promised; the
  promise occasionally breaks).
- Composes with (b) — produces the error string the retry inserts.

---

## 3. Composition matrix

Rows are layers; columns are which problem class each fixes.
Cells indicate `solves` / `mitigates` / `n/a`.

| Layer                                   | §1.1 Envelope mismatch | §1.2 Tool-call drift | Refusal / vacuity | Truncation | Type drift |
|-----------------------------------------|------------------------|----------------------|-------------------|------------|------------|
| (a) Constrained decoding (`json_schema` + strict tools) | mitigates | solves | n/a            | mitigates  | solves     |
| (b) Retry with corrective feedback      | mitigates              | mitigates            | mitigates         | mitigates  | mitigates  |
| (c) Tolerant parsers                    | solves                 | n/a                  | n/a               | mitigates  | n/a        |
| (d1) Verifier unwrap                    | solves                 | n/a                  | n/a               | n/a        | n/a        |
| (d2) Codeblock convention               | solves                 | n/a                  | n/a               | n/a        | n/a        |
| (e) Tool-as-contract                    | solves                 | solves               | mitigates         | mitigates  | solves     |
| (f) Vacuity detection                   | n/a                    | n/a                  | solves            | n/a        | n/a        |
| (g) Schema validation                   | n/a                    | n/a                  | mitigates         | mitigates  | solves     |

### Redundancy notes

- **(a) ⊕ (e) is not redundant.** Strict tool use is a special case of
  constrained decoding *applied to tool args*. When the agent submits
  the answer via a tool, (a) and (e) collapse into one move. When the
  agent emits chat-JSON (because the consumer chose the cheaper
  contract), (a) covers it without (e).
- **(c) ⊕ (a) is not redundant.** Even constrained decoding is
  truncation-vulnerable. Tolerant parser shrinks the truncation-fail
  rate.
- **(d1) ⊕ (d2) IS redundant when both are on.** Pick one path per
  contract, not both — see §4.4 below.
- **(b) ⊕ (a) IS redundant where (a) is enforced strictly** (OpenAI
  strict, Anthropic strict, Bedrock Claude strict). On those backends
  (b) catches only network errors and refusals, not format errors.
  Keep (b) anyway, because the substrate doesn't know which backend
  the operator deployed; (b) is the universal fallback.
- **(f) ⊕ (g) is not redundant.** (g) catches "field is wrong type";
  (f) catches "field is right type, content is empty / refusal."
  Different signals.

### Recommended stack (most-leverage ordering)

For every output contract, in order:

1. **(g) Schema validation** — non-negotiable foundation.
2. **(e) Tool-as-contract** — when the backend supports strict tool
   use. This is THE single biggest leverage point.
3. **(a) Constrained decoding** — when (e) is unavailable AND the
   backend supports `response_format: json_schema`.
4. **(c) Tolerant parsers** — always, as a parsing step.
5. **(d1) Envelope-aware verifier** — non-optional once the
   substrate envelope changes (§4).
6. **(b) Retry** — capped at 2, always on.
7. **(f) Vacuity detection** — substrate-side, runs free.
8. **(d2) Codeblock convention** — only for backends with no
   structured-output support at all (the Ollama
   `nemotron-nano-4B`-class fallback).

---

## 4. Recommendations for kagent v0.2

Ordered by leverage. Each item lists files touched and what the
change is.

### 4.1 Reshape the envelope (`packages/agent-pod/src/status.ts:69`)

The single most impactful change. Today:

```ts
result: { content: result.finalContent },
```

…flattens free-text and structured cases into one. Proposal:

```ts
result: {
  text: result.finalContent ?? null,
  structured: result.structuredAnswer ?? null,
  // back-compat alias — remove in v0.3
  content: result.finalContent,
},
```

…where `RunResult.structuredAnswer` is set by the runner when:

- the agent's outputContract is `mode: 'tool-call'` and the
  loop terminated on a `submit_answer` tool call → arguments are
  parsed + validated and stored here, AND `result.text` carries the
  agent's final assistant chat text (typically empty).
- the agent's outputContract is `mode: 'json'` and the runner's
  output post-processing pipeline successfully parsed the final
  message → parsed JSON stored here, `result.text` carries the raw
  string.
- the agent's outputContract is `mode: 'free-text'` (or unset) →
  `structured` stays null, `result.text` is the answer.

Back-compat: keep `result.content` populated identically to today
for one release cycle. Mark deprecated in `status.ts` JSDoc.
Operator + UI consumers migrate to `result.text` / `result.structured`.

### 4.2 Output post-processing pipeline in the runner (`packages/agent-pod/src/runner.ts`)

After `executor.run(...)` returns, before `RunResult` is built,
insert a four-stage pipeline:

```
extract → tolerant-parse → schema-validate → vacuity-check
```

Implementation sketch (new `output-pipeline.ts`):

```ts
export interface OutputPipelineResult {
  status: 'ok' | 'retry' | 'fail';
  text: string;        // what gets written to result.text
  structured: unknown; // what gets written to result.structured
  diagnostic?: { stage: string; message: string };
}

export function runOutputPipeline(
  finalContent: string | null,
  toolCalls: readonly ToolCall[],
  contract: OutputContract | undefined,
): OutputPipelineResult { ... }
```

Stages:

1. **Extract.** Mode-aware:
   - `mode: 'tool-call'`: extract from `toolCalls.find(c => c.name === contract.toolName)`.
   - `mode: 'json'` + `strategy: 'final-codeblock'`: pull last
     ```` ```kagent-output ```` block out of `finalContent`.
   - `mode: 'json'` + `strategy: 'whole-message'`: use
     `finalContent` directly.
   - `mode: 'free-text'`: pass through, `structured: null`.
2. **Tolerant parse.** `dirty-json` chain. Bracket-balanced extraction
   if step (1) emitted prose-with-JSON. (See §2(c).)
3. **Schema-validate.** Zod schema derived from
   `contract.schema` (a JSON Schema string in the CRD, parsed at
   pod boot). On failure, attach the Zod error path.
4. **Vacuity-check.** Walk the structured value; if string fields
   match the refusal-phrase list (`packages/agent-loop/src/detectors/refusal.ts`)
   OR fall below `contract.minStringLength`, return
   `status: 'retry'` with a refusal diagnostic.

Pipeline outcomes:

- `status: 'ok'` — write to `RunResult.structuredAnswer`.
- `status: 'retry'` — append a corrective-feedback message to the
  loop's history and re-run via `executor.run(...)` ONE additional
  iteration. Cap: 2 retries total. After cap exhausted →
  `status: 'fail'` with diagnostic surfaced as `RunResult.error`.
- `status: 'fail'` — terminal; write `phase: 'Failed'` with
  `error: 'output_contract_violated: <stage>: <message>'`.

### 4.3 Envelope-aware verifier (`packages/operator/src/verifier.ts:812`)

Change the unwrap. Today:

```ts
const resultJson = JSON.stringify(task.status?.result ?? null);
```

Proposal:

```ts
const resultJson = renderResultForJudge(task.status?.result);
```

…where `renderResultForJudge` is a small helper:

```ts
function renderResultForJudge(result: unknown): string {
  if (result === null || result === undefined) return 'null';
  if (typeof result !== 'object') return JSON.stringify(result);
  const r = result as { text?: unknown; structured?: unknown; content?: unknown };
  // Preferred: structured if present (the agent had an output contract).
  if (r.structured !== null && r.structured !== undefined) {
    return JSON.stringify(r.structured);
  }
  // Fall back to text (free-text contract or no contract).
  if (typeof r.text === 'string') return r.text;
  // Back-compat: legacy envelope.
  if (typeof r.content === 'string') return r.content;
  return JSON.stringify(result);
}
```

Update the LLM-judge prompt convention (in Langfuse, owned by the
prompt author) to expect `{{outputs}}` to be the unwrapped answer,
not the envelope. Tag the prompt-template version bump in the
verifier audit so we can tell which template was active for each
verdict.

Add a tolerant-parse step on the *input side* of the judge prompt
too: if the unwrapped result is a string that *looks* like JSON (per
a regex), parse it once and re-render. This handles legacy
envelopes that landed before the `4.1` change.

Wire the (f) pre-check: if `task.status.structuralVerdict.suspicious`
contains `refusal`, fail-fast with
`verdict:fail: refusal_detected_in_pipeline` and skip the judge
round-trip.

### 4.4 New CRD field: `Agent.spec.outputContract`

Optional. Absent = today's free-text behavior (back-compat).

```ts
export interface OutputContract {
  /**
   * Validation schema for the structured answer. JSON Schema string,
   * compiled to Zod at agent-pod boot. Cross-validated against the
   * provider when `strategy.constrainedDecoding === true` is requested
   * but the provider doesn't support it (warn + degrade to retry-only).
   */
  readonly schema?: string;

  /**
   * How the structured answer is conveyed by the model:
   *   - 'tool-call'  — submit_answer tool. Strongest. Default when
   *                    the resolved provider supports strict tool use.
   *   - 'json'       — chat-text JSON. Default when the provider
   *                    supports response_format: json_schema but not
   *                    strict tool use.
   *   - 'free-text'  — no structured answer. Default when contract is
   *                    omitted entirely or no schema is set.
   */
  readonly mode: 'tool-call' | 'json' | 'free-text';

  /**
   * Mode-specific tunables.
   */
  readonly toolName?: string;          // 'tool-call' mode; default 'submit_answer'
  readonly jsonStrategy?: 'whole-message' | 'final-codeblock';

  /**
   * Whether the runner SHOULD attempt to use provider-side
   * constrained decoding. Default true. Set false only for
   * debugging or when the provider's grammar implementation is
   * known-broken on this Agent's model.
   */
  readonly constrainedDecoding?: boolean;

  /**
   * Retry budget for the output post-processing pipeline. Default 2.
   * Range 0..3 (3 is the practical ceiling per Instructor numbers).
   */
  readonly retryBudget?: number;

  /**
   * Vacuity-detection knobs. `minStringLength` is the per-string-field
   * lower bound; `refusalPhraseSet` is one of 'default' | 'none'.
   */
  readonly vacuity?: {
    readonly minStringLength?: number;
    readonly refusalPhraseSet?: 'default' | 'none';
  };
}
```

Schema authoring lives in the Langfuse prompt, NOT in the CRD,
because the schema commonly changes when the prompt changes and
the prompt is already prompt-versioned. The CRD field carries the
*reference*, not the body. Add the matching ref shape:

```ts
readonly schemaRef?: { readonly name: string; readonly version?: number };
```

…parallel to `systemPromptRef`.

### 4.5 Where to insert constrained decoding

Two valid layers; **both** should be wired, with provider-side as
the default and gateway-side as a substrate-policy backstop.

**Provider-side (in the agent-pod, threaded via `openai-compat`).**
Plumb `response_format` and `tools[].strict` through
`packages/openai-compat/src/request-builder.ts`. Today the builder
omits `tools` when empty; it does not thread `response_format` at
all. Two lines of plumbing in the builder + a 30-line schema-derive
helper from Zod → JSON Schema. This is the **primary** path. The
agent-pod is closest to the schema source-of-truth (the Agent CR's
`outputContract.schemaRef`).

**Gateway-side (in `kagent-llm-gateway`, optional v0.3+).**
The gateway can inspect outbound bodies and inject
`response_format: json_schema` when an Agent's contract demands it
but the agent-pod's `runner.ts` failed to set it. This is a
defense-in-depth move, not a primary path. Skip in v0.2; revisit
when the gateway gets a more general transformation pipeline.

### 4.6 Detector bridge (`packages/agent-loop/src/detectors`)

Add `vacuous_output` to `quality-flags.ts`. Wire `detectRefusal`'s
phrase list (currently free-floating in `refusal.ts`) so the new
flag and the existing detectors share one table.

Surface `refusal` as a flag id in the `structuralVerdict.suspicious`
array (today `detectRefusal` is called by external glue, not by
`computeQualityFlags`). The verifier's pre-check (§4.3) reads from
this array; the array is the existing audit surface.

### 4.7 Prompt-template hygiene (Langfuse-side, not code)

Two small operational tasks (no CRD, no code):

1. The `verifier-llm-judge` prompt template's `{{outputs}}` placeholder
   contract changes meaning under §4.3 — it now receives the
   unwrapped answer, not the envelope. Bump the template version
   and update the rendering preamble accordingly:

   ```
   You are a verifier. The agent was asked: {{question}}
   The agent answered: {{outputs}}
   Decide whether the answer is correct + on-format.
   Respond ONLY in JSON: {"verdict":"pass"|"fail","reason":"..."}
   ```

2. Where today's templates pre-explain "the agent's answer is
   wrapped in `{content: ...}`," strip that — the verifier no
   longer hands the envelope through.

---

## 5. Out of scope / explicit non-goals

The following are tempting and DO NOT belong in v0.2:

- **A kagent-owned constrained-decoding engine.** We use the
  provider's. If the provider doesn't have one, we degrade. We do
  not vendor llguidance / Outlines / XGrammar in-tree.
- **A kagent-owned model fine-tune for tool-use.** The
  matrix in §2(e) makes the policy clear: when the deployed model
  doesn't support strict tool use, the consumer chose the cheaper
  contract. The substrate exposes the contract; the consumer
  picks the model.
- **A LLM-based JSON-repair pass.** Instructor offers it; it costs
  another full LLM round-trip per repair. Substrate-level it would
  burn tokens on every consumer's bad day. Application-layer can
  do this in their own loop.
- **DSL for schema definition.** JSON Schema is the lingua franca.
  Authors write Zod (for TS) or JSON Schema (in Langfuse) and we
  thread one or the other.
- **Consumer-controlled retry budgets > 3.** The
  `outputContract.retryBudget` is bounded at 3 deliberately. Higher
  values reliably indicate the model is wrong, not the prompt.
- **Streaming structured outputs.** v0.1 + v0.2 are non-streaming
  at the substrate level (the agent-pod's writeback is batch). The
  streaming structured-output story (partial-JSON + incremental
  status patches) is a v0.4 problem.
- **Cross-tool routing intelligence.** "Which tool should the model
  call?" is application-layer. Substrate provides the
  `submit_answer` slot; agent system prompt + the available tools
  do the rest.

---

## 6. Open questions (need user input)

These decisions block implementation and need explicit answers:

1. **Cloudflare workers-ai strict tool-use status.** As of Q1 2026
   the workers-ai docs assert OpenAI-compat for `response_format`
   but do not cleanly document `tools[].strict` for Llama 4 Scout.
   We need an empirical probe — RC pilot rerun with `strict: true`
   threaded — before we set the v0.2 default. **Action:** wire it,
   stamp evidence to `evidence/`, then decide whether
   `outputContract.mode: 'tool-call'` is the substrate default for
   the workers-ai backend or just a recommended option.

2. **Default retry budget.** Instructor's published numbers (95% →
   99.5% within one retry; 99.5% → 99.9% within two) suggest 2 is
   the cost/value sweet spot for high-tier models. For
   nemotron-nano-class models 2 retries lifts adherence from ~30%
   to ~65% — still bad. Should the substrate default be **2** (good
   for the recommended workers-ai/Llama-4-Scout path) or **3** (a
   bit more headroom for nemotron-class)? **Recommendation:** 2,
   and let `Agent.spec.outputContract.retryBudget` opt up.

3. **Policy when provider rejects schema.** workers-ai
   occasionally returns 400 on certain schema combinations
   (deeply-nested anyOf). What's the substrate policy?
   - (a) Fail the task (`output_contract_unsupported`).
   - (b) Degrade silently to `mode: 'json'` + retry.
   - (c) Degrade with a `WARN` audit event but otherwise proceed.
   **Recommendation:** (c). Visibility without a hard block.

4. **Tool-name namespace clash.** Is `submit_answer` a reserved
   tool name in the substrate (the runner refuses to dispatch
   user-defined `submit_answer` tools), or do we let the
   `outputContract.toolName` field carry an Agent-specific name?
   **Recommendation:** Reserved with override — the default name
   is `submit_answer`; an Agent can change it via
   `outputContract.toolName`, but the runner refuses to declare a
   second tool of the same name (collision in the
   `Agent.spec.tools[]` list → admission error).

5. **Where does the schema live?** Two valid options:
   - (a) Inline JSON Schema in the Agent CRD's
     `outputContract.schema` field.
   - (b) Langfuse-managed prompt the substrate fetches at boot
     (mirrors `systemPromptRef` shape).
   **Recommendation:** both. Prefer ref when set; fall back to
   inline. The ref path lets schema authors version + promote
   without a CRD edit; the inline path keeps Agent CRs
   self-contained for testing.

6. **Back-compat tail.** Today's deployed AgentTasks read
   `status.result.content` directly (Workbench, etc.). The §4.1
   shape change keeps `content` populated for "one release."
   Concrete deprecation calendar: warn at v0.2.0; remove at v0.3.0.
   OR: never remove, document as "legacy alias." **Recommendation:**
   keep as legacy alias indefinitely. The substrate's job isn't to
   force consumer migrations.

7. **Whether substrate detectors get an LLM-judge override.** The
   §4.3 pre-check fails the task on a refusal-detection match. Is
   it correct to skip the LLM judge entirely, or should the LLM
   judge get a chance to override (e.g. for a refusal phrase that
   IS the correct answer to a prompt about refusals)? Substrate
   bias: skip is correct; the judge round-trip is an expense and
   refusal-as-correct is a corner case. Open to the user
   disagreeing.

---

## 7. Summary

The two RC failures are not bugs to patch one at a time. They are
symptoms of the substrate having one envelope shape, no contract
language for "this Agent emits structured output," no constrained
decoding on the wire, and no vacuity bridge between detectors and
the verifier. The fixes are mechanical and substrate-shaped: a new
optional CRD field (`outputContract`), a four-stage runner pipeline,
an envelope-aware verifier render path, and a small detector bridge.

The single largest leverage point is **(e) tool-as-contract** with
the runner emitting a `submit_answer` tool when the provider supports
strict tool use. That alone fixes both RC failures at once. The rest
of the catalog is the safety net for backends that don't have that
capability.

---

### Cross-references

- `packages/agent-pod/src/status.ts:69` — `buildStatusPatch` (envelope shape).
- `packages/agent-pod/src/status.ts:82` — `result: { content: ... }`.
- `packages/agent-pod/src/runner.ts:281` — `computeQualityFlags` invocation.
- `packages/agent-pod/src/runner.ts:298–301` — artifact merge (precedent for similar post-pipeline shape).
- `packages/operator/src/verifier.ts:326` — `renderLlmJudgePrompt`.
- `packages/operator/src/verifier.ts:337` — `parseVerifierJudgeReply` (existing tolerant-parse precedent).
- `packages/operator/src/verifier.ts:812` — `JSON.stringify(task.status?.result ?? null)` (the bug).
- `packages/agent-loop/src/detectors/quality-flags.ts` — existing detectors.
- `packages/agent-loop/src/detectors/refusal.ts:26` — refusal phrase list.
- `packages/operator/src/crds/types.ts:60` — `AgentSpec`.
- `packages/operator/src/crds/types.ts:780` — `VerifyContract`.
- `packages/operator/src/crds/types.ts:856` — `AgentTaskStatus`.
- `packages/openai-compat/src/request-builder.ts` — wire here for `response_format` + `tools[].strict`.
- `docs/HARNESS-LESSONS.md` — origin story for the existing detectors.
- `docs/DESIGN-V0.1.md` — v0.1 envelope (the thing we're proposing to evolve).
