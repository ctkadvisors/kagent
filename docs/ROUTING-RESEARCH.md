# Routing Research — How Production AI Dev Tools Pick a Model

**Date:** 2026-05-05
**Status:** Research input for ROADMAP Phase B (multi-endpoint routing).
**Owner / scope:** substrate. Informs `@kagent/llm-gateway` evolution from
single-candidate exact-match (`router.ts:112`) to capability-aware
multi-candidate selection.

---

## 1. Problem framing

Today the gateway is a one-trick: `request.model` → `Map.get(modelName)` →
single `ModelEndpoint` (see `packages/llm-gateway/src/router.ts:112`,
`packages/llm-gateway/src/model-index.ts:51`). The CRD shape
(`packages/operator/src/crds/types.ts:1108-1140`) says one (model,
backendKind, backendUrl) tuple per CR, and the index is
last-write-wins because the key is `spec.model` only.

That worked for v0.1 — admission + AIMD + a single Cloudflare backend.
Phase B raises three pressures:

1. **Multiple backends per model.** A homelab Llama-3.3-70B may be on
   Ollama AND on workers-ai AND on Bedrock — same logical model,
   three endpoints. Pick by load / latency / cost / availability.
2. **Capability filtering.** `docs/RESILIENT-CONTRACTS.md` §4.4
   introduces `Agent.spec.outputContract.mode = 'tool-call' | 'json'
   | 'free-text'`. Tool-call mode REQUIRES a backend that supports
   strict tool use. The router has to reject endpoints that can't
   honor the contract before it even tries them.
3. **"Auto" affordance.** Operators want to say "give me a
   tool-capable, cheap-tier, on-cluster model" and let the substrate
   pick. They don't want to enumerate candidate IDs in the Agent CR.

This doc surveys how production tools solve those three pressures and
recommends a concrete shape for kagent's Phase B router.

Cross-refs:
- `docs/ROADMAP.md` — Phase A (admission), Phase B (multi-endpoint).
- `docs/RESILIENT-CONTRACTS.md` §4.4 — outputContract.mode.
- `docs/PRIOR-ART.md` — Bedrock router, Cloudflare AI Gateway.
- `packages/llm-gateway/src/aimd.ts` — per-(model, endpoint) tuner,
  the unit a multi-candidate router scores against.

---

## 2. Comparison matrix

One row per system. Columns are the four research dimensions.

| System | User-visible "auto" | Selection signals | Candidate classification | User override |
|---|---|---|---|---|
| **A. Cursor Auto** | `Auto` model in picker. No fast/slow toggle. | Server load + model availability + degraded-perf detection + (claimed) task complexity. Excludes o3 from the pool. | Hard-coded curated pool of premium models. No public capability declaration. | Pick a specific model from the dropdown. Auto is unlimited on paid plans; manual selections may consume credits. |
| **B. GitHub Copilot Auto** | `Auto` in chat / agent / CLI picker. Three separate pools. | Plan + policies + perceived task type (chat vs agent vs CLI). Rate-limit avoidance is explicit goal. | Per-context curated lists (chat: Sonnet 4.6 + GPT-5.3-Codex + Grok Code Fast; agent: Sonnet 4.5 + Grok Code Fast; CLI: Sonnet 4.6 + GPT-5 mini + others). | Pick from 23 named models. Org policies can mask the pool. |
| **C. Continue.dev** | No "auto." `roles` taxonomy: `chat`, `autocomplete`, `edit`, `apply`, `embed`, `rerank`, `summarize`. | Role-match: a model declares the roles it can play; the IDE picks the first model with the matching role. | User declares roles per model in `config.yaml`. Capabilities (`tool_use`, `image_input`) are also declarable. | User's `models[]` array IS the pool; user's `roles` array IS the routing logic. |
| **D. Aider** | No "auto." Three named slots: `--model` (architect / main), `--editor-model`, `--weak-model`. Architect mode runs main+editor as a pair. | Hard-wired role split. Architect plans, editor produces diffs, weak does commit messages + summaries. | Model-string convention only. Each slot is a single model, not a pool. | Set each `--*-model` flag explicitly. Sensible defaults derive editor from main. |
| **E. LiteLLM Router** | Two layers: (1) `model_group_alias` collapses many deployments into one logical name; (2) `Auto Router` (semantic content-aware) picks a logical model from utterance-tagged routes. | `routing_strategy`: `simple-shuffle` (weighted-RPM, default), `latency-based-routing`, `usage-based-routing-v2` (lowest TPM via Redis), `least-busy` (lowest in-flight), `cost-based-routing` (cheapest). Plus `tag-based-routing` and `auto-router` (semantic). | `model_list[]` with `rpm`, `tpm`, `weight`, `order`, `max_parallel_requests`, `region_name`. Capability inferred per-provider via the LiteLLM provider table. | Pass `model="<group_name>"`; rely on the strategy. Or `extra_body.tags`. Or use a different `routing_group` name. |
| **F. OpenRouter Auto** | `openrouter/auto` virtual model, powered by NotDiamond. | NotDiamond meta-model: prompt complexity + task type + model capabilities. ~33 model curated pool. | Curated. User can constrain via wildcards in `plugins` parameter (e.g. `anthropic/*`). | Pass a specific `model=` parameter, or wildcard-restrict the auto pool. No nitro/floor variants on auto. |
| **G. OpenAI / Anthropic SDKs** | None. Anthropic guidance: start with Sonnet, route simpler down to Haiku, hardest up to Opus. OpenAI guidance: Mini for cheap, full-tier for default, o-series for reasoning. | Documentation-only. No SDK-layer router. | Tier names: Haiku/Sonnet/Opus, Mini/full/o. | Caller-side switch on the tier names. |
| **H. AWS Bedrock Intelligent Prompt Router** | Specify a *prompt-router ARN* instead of a model ARN. | Two-model family route (e.g. Haiku ↔ Sonnet, Llama-3.1-8B ↔ Llama-3.3-70B). Bedrock predicts which model in the family will produce the desired response cheapest. Claims up to 30% cost reduction. | Hard-wired per family. CFN type `AWS::Bedrock::IntelligentPromptRouter` accepts exactly two model ARNs of the same family. | Specify the model directly to bypass the router. |

### Quick observations

- **Two patterns dominate the user-facing "auto" knob.** Either (a)
  one global "Auto" name (Cursor, Copilot, OpenRouter) hiding a
  curated pool; or (b) a *role* taxonomy (Continue, Aider) where the
  user binds models to roles and the IDE/CLI picks per-role. LiteLLM
  blends both via `model_group_alias` + `Auto Router`.
- **Capability declaration is the weak point everywhere.** Continue
  is the only one that lets the user declare per-model capabilities
  (`tool_use`, `image_input`) in config. LiteLLM has a per-provider
  table (closed list, not user-configurable). Cursor / Copilot /
  OpenRouter / Bedrock don't expose it at all — the routing system
  knows internally and the user doesn't.
- **Bedrock's "intelligent prompt routing" is purely intra-family.**
  It doesn't cross Anthropic↔Llama; it picks the cheap model in a
  family when the prompt is easy. This is more like AIMD-on-cost
  than capability routing.
- **"Auto" without override is rare.** Every system that ships an
  Auto mode also ships a manual picker. The auto is a default, not
  a primitive.

---

## 3. Pattern catalog

Eight recurring patterns. For each: where it shows up, what it costs,
how it composes.

### 3.1 Capability-class filtering

**What:** Before scoring, drop endpoints that can't honor the
request's hard constraints. Common capability dimensions:

- `tool-use` — backend supports OpenAI-style `tools[]` + tool calls.
- `tool-use-strict` — backend honors `tools[].strict: true` (i.e.
  grammar-constrained tool args). Subset of tool-use.
- `vision` — backend accepts `image_url` or `image` content parts.
- `long-context` — context window ≥ N (e.g. 128k, 200k, 1M).
- `embedding` — backend produces embedding vectors, not chat.
- `image-gen` — backend produces image bytes, not text.
- `structured-output` — backend honors
  `response_format: json_schema`.
- `prompt-caching` — backend honors `cache_control` blocks
  (Anthropic) or `prompt_cache_key` (OpenAI).

**Where it shows up:**
- Continue.dev: explicit `capabilities: [tool_use, image_input]`
  per model in `config.yaml`.
- LiteLLM: implicit via the provider-table — `tools` is
  passed-through if the provider supports it, dropped otherwise.
- OpenRouter: implicit — Auto's pool is curated to all-capable
  models; `vision` is exposed as a separate collection
  (`/collections/vision-models`).
- vLLM Semantic Router: explicit — different intent classes route
  to different model pools.

**Cost:** zero — pre-scoring filter, evaluated against static
metadata.

**Composes with:** every other pattern. Capability filter runs FIRST,
score function runs over survivors.

### 3.2 Cost-tier selection (cheap / normal / premium)

**What:** Map a "tier" intent to a cost class.

**Where:**
- Anthropic docs: Haiku (cheap) / Sonnet (normal) / Opus (premium).
- OpenAI docs: Mini / full / o-series.
- Bedrock IPR: route easy prompts to the cheap model in the family.
- Aider: weak-model role explicitly = cheap; main = expensive.

**Cost:** zero, when the cheaper model is enough. Decided cost when
the cheap model fails and the request gets re-routed up.

**Composes with:** capability filter (cheap-and-tool-capable is a
filter intersection); fallback chain (try cheap first, escalate on
failure).

### 3.3 Latency-budget routing

**What:** Score endpoints by recent observed latency; pick the
fastest. Optional `lowest_latency_buffer` to spread load across
top-N rather than always picking #1 (avoids hot-spotting the
fastest endpoint into degradation).

**Where:**
- LiteLLM `latency-based-routing`: caches per-deployment p50; picks
  lowest. Configurable TTL.
- Cursor: claims to detect "degraded model performance" and switch.
- Copilot Auto: explicit goal of "reduce rate limits."

**Cost:** O(N) over candidates; sub-ms. Memory: rolling samples per
endpoint. **Already in our `aimd.ts`** — every endpoint maintains a
50-sample rolling p50.

**Composes with:** AIMD — when AIMD halves a cap on latency-spike,
the latency-router naturally avoids that endpoint until the cap
recovers. Composes with stickiness: once you've routed a session,
don't re-route on a single latency uptick.

### 3.4 Load-balanced / least-busy

**What:** Score endpoints by current in-flight count; pick the
lowest.

**Where:**
- LiteLLM `least-busy`.
- Implicit in `simple-shuffle` (RPM-weighted random).
- Default behavior of any router that respects per-endpoint RPM
  caps.

**Cost:** O(N) over candidates. Memory: in-flight counter
(**already in our `inflight-counter.ts`**).

**Composes with:** AIMD cap is the upper bound; least-busy picks
within the cap. Composes with capability filter.

### 3.5 Fallback chains on 5xx / rate-limit

**What:** Try primary; on 5xx / 429 / timeout, try fallback. Some
systems chain: primary → first-fallback → second-fallback. Cooldown
the failed endpoint for N seconds before retrying.

**Where:**
- LiteLLM: `fallbacks=[{primary: [fb1, fb2]}]` + `cooldown_time` +
  `allowed_fails`.
- OpenRouter: provider-routing backup selection.
- Cursor Auto: claims to "switch models" on degradation.

**Cost:** extra round-trip on the failure path. Token cost: the
failed request's tokens are billed, the fallback re-pays. Cap with
`num_retries`.

**Composes with:** AIMD — multiplicative-decrease handles the
local-cap cooldown. The router-level cooldown is COARSER (whole
endpoint marked unavailable for N seconds). Both are useful at
different timescales.

### 3.6 Stickiness (session-pin)

**What:** Once a request lands on endpoint E, all follow-ups in
the same conversation route to E unless E is unavailable. Avoids
mid-conversation context-cache invalidation.

**Where:**
- Anthropic prompt caching strongly rewards this (cache hits cost
  10% of misses).
- Cursor: per-session model is pinned UNTIL Auto detects
  degradation.
- LiteLLM: not built-in; users add via `extra_body.metadata` +
  `tag-based routing`.

**Cost:** zero direct. Indirect: defeats some load-balancing goals;
worth it for prompt-cache savings.

**Composes with:** AIMD — if the sticky endpoint hits its cap, the
session can NACK with `at_cap` and the client decides whether to
fail or unpin.

### 3.7 Tool-vs-chat split (per-task-type role)

**What:** Different tasks → different models, hard-wired by config.

**Where:**
- Continue.dev: `roles: [chat]` vs `roles: [autocomplete]`. The
  `autocompleteModel` is by convention small + fast (e.g.
  `starcoder2:3b`); the `chatModel` is large + smart.
- Anthropic: implicit — Haiku for tab-complete, Sonnet for chat.

**Cost:** zero direct. Operational: requires the user to actually
declare two models, which most users do.

**Composes with:** capability filter — autocomplete-role models are
typically small and don't need tools; chat-role models do. The
roles taxonomy IS a capability filter projected onto task-shape.

### 3.8 Strong/weak split (Aider's pattern)

**What:** Within a single agentic task, dispatch sub-steps to
different models. Architect (strong) plans; editor (medium) emits
diffs; weak writes commit messages.

**Where:**
- Aider: explicit three-slot model.
- LangGraph / CrewAI: optional, idiomatic.
- DSPy: `dspy.LM` per module.

**Cost:** more round-trips, more sums-of-tokens. Wins are quality
(strong reasoning isn't wasted on diff format) and cost (strong
isn't billed for commit-message work).

**Composes with:** none of the above directly — this is an
*application-layer* pattern. The substrate exposes it by letting
the agent pod's loop call the gateway with different `model`
values per step. The loop is the architect of strong/weak; the
gateway just routes.

### Summary of which patterns matter for kagent

| Pattern | Substrate-level? | Already partial in v0.1? |
|---|---|---|
| 3.1 Capability filter | yes — required for `outputContract.mode` | no — model-index has no capability fields |
| 3.2 Cost tier | yes — operators want cheap-tier on homelab | no — `ModelEndpoint` has no `costClass` |
| 3.3 Latency budget | yes — second-order signal | partial — AIMD tracks p50 per endpoint, not surfaced for routing |
| 3.4 Load-balanced | yes — primary signal | partial — `InFlightCounter` exists; not used for selection |
| 3.5 Fallback chains | yes — important for robustness | no |
| 3.6 Stickiness | application — agent loop's job | n/a |
| 3.7 Task-type split | application — Agent CR's job | n/a |
| 3.8 Strong/weak | application — agent loop's job | n/a |

**Substrate adopts: 3.1, 3.2, 3.3, 3.4, 3.5.** 3.6/3.7/3.8 are
application-layer; substrate exposes them by letting agent pods set
a different `model` per call. (See §4.4 below: the substrate's job
is to make `model="kagent/auto"` work, not to make the agent loop
"smart.")

---

## 4. Recommendation for kagent Phase B

Concrete proposal in five parts.

### 4.1 Class taxonomy

Adopt FIVE substrate-level capability classes. (Validates Chris's
shortlist with one substitution.)

| Class | Dimension | Definition | Example endpoints (May 2026) |
|---|---|---|---|
| `tool-capable` | function/tool calling | Backend honors `tools[]` AND emits structured `tool_calls[]` (not free-text). | OpenAI gpt-5.4, Anthropic Sonnet 4.6, Bedrock Claude, workers-ai/llama-4-scout, Ollama llama-3.3-70b |
| `tool-strict` | strict tool use | Backend honors `tools[].strict: true` (grammar-constrained tool args). Subset of `tool-capable`. | OpenAI gpt-5.x, Anthropic Sonnet/Opus 4.x with `strict-2025-11-13` header, Bedrock Claude. NOT workers-ai today. |
| `vision` | multimodal input | Backend accepts `image_url` content parts. | OpenAI gpt-5.x, Anthropic Sonnet/Opus 4.x, workers-ai/llama-4-scout, Bedrock Claude, Gemini 3.x |
| `long-context` | ≥ 200k token window | Hard threshold rather than free-form number — keeps the predicate simple. | Anthropic Sonnet 4.6 (1M), Anthropic Opus 4.7 (1M), Gemini 3.x (2M), Bedrock Claude any |
| `cheap-tier` | cost class | Per-token cost ≤ a threshold. Default threshold: input ≤ $0.50 / Mtok AND output ≤ $2.50 / Mtok. (Empirically: Haiku 4.5, GPT-5 mini, workers-ai Llama-4-Scout, all Ollama.) | Haiku 4.5, GPT-5 mini, workers-ai/*, Ollama/* |

**Substitution from Chris's shortlist:** `homelab-only` → drop. The
homelab/cloud distinction is an *operational* concern (e.g.
"don't ship sensitive data to a hosted provider"), not a capability
class. Express it via a separate orthogonal label —
`backendKind in ['ollama', 'localai', 'exo']` — exposed as a
`routingHints.requireBackend` gate. Mixing it into the capability
class taxonomy makes it brittle: the next on-prem backend
(`vllm`, etc.) gets categorized wrong.

**Reasoning:** five classes is the most-leverage cut. More classes
add operator burden (every CR has to declare them). Fewer classes
miss the `tool-call` requirement from `outputContract.mode`, which
is the gating use-case.

**Class declaration mechanism.** Two options, pick one:

- **Static per-CR.** Operator declares the classes when writing the
  `ModelEndpoint` CR:
  ```yaml
  spec:
    model: anthropic/claude-sonnet-4-6
    backendKind: anthropic
    backendUrl: https://api.anthropic.com
    capabilities: [tool-capable, tool-strict, vision, long-context]
    cost: { inputPerMtok: 3.00, outputPerMtok: 15.00 }
  ```
  Substrate derives `cheap-tier` from the cost block.
- **Provider-table inferred.** Substrate ships a built-in table
  (`backendKind, modelPattern → capabilities`) and the gateway
  resolves at watch-time. Operator can override per-CR.

**Recommendation: provider-table inferred + per-CR override.** The
operator shouldn't have to remember whether Sonnet supports vision;
the substrate ships a curated table (like LiteLLM's). Operator
overrides only when they genuinely need to (e.g. workers-ai
Llama-4-Scout's `tool-strict` status today is "partial" — operator
sets `tool-strict: false` until that probes clean).

### 4.2 Selection algorithm — filter → score → pick

```
Input: request
  - request.model           (string, possibly 'kagent/auto')
  - request.required        (capability set, derived from outputContract)
  - request.preferredTier   ('cheap' | 'normal' | 'premium' | undefined)
  - request.routingHints    (Agent.spec.routingHints, see 4.4)
  - request.tools[]         (raw OpenAI-shape tool list)
  - request.response_format (raw OpenAI-shape)

Step 1: Resolve candidate set.
  - If request.model is an exact ModelEndpoint name → candidates = [that one].
  - If request.model === 'kagent/auto' → candidates = ALL ModelEndpoints.
  - If request.model === 'kagent/<class>/<tier>' → candidates = filtered by
    that class+tier (e.g. 'kagent/tool-capable/cheap').

Step 2: Hard filter.
  - Drop candidates where capabilities ⊉ request.required.
  - Drop candidates where routingHints.allowedBackends rules match.
  - Drop candidates where AIMD cap == 0 (in cooldown).
  - Drop candidates where in-flight ≥ AIMD cap (at-cap).

Step 3: If candidate set empty:
  - If request.required is nonempty → 400 capability_unavailable.
  - Else → 503 all_endpoints_at_cap (Retry-After hint).

Step 4: Score survivors.
  - score = w_load * loadScore(candidate)
          + w_latency * latencyScore(candidate)
          + w_cost * costScore(candidate, preferredTier)
          + w_priority * staticPriority(candidate)
  where:
    loadScore     = 1 - (inFlight / cap)        ∈ [0,1], higher = freer
    latencyScore  = clamp(1 - (p50 / threshold), 0, 1)
    costScore     = depends on preferredTier (see below)
    staticPriority = candidate.spec.priority ?? 50  (operator escape hatch)

Step 5: Pick the highest-scored candidate.
  - Tie-break by lower cost, then by lower p50, then by name (stable).

Step 6: Dispatch via the existing flow:
  - aimd.updateBounds(...) → inFlight.acquire(...) → provider.chatCompletion(...)
  - On success/error, AIMD updates as today.

Step 7: On dispatch failure (5xx, network):
  - If routingHints.fallback === 'on' (default), retry on the
    next-highest-scored candidate (from the original survivor set,
    minus the just-failed one). Cap retries at 2.
  - On exhaustion → 502 dispatch_error_all_candidates.
```

**Default weights.** `w_load = 0.4, w_latency = 0.3, w_cost = 0.2,
w_priority = 0.1`. Tunable via `LlmGatewayConfig` env. Rationale:
load-shedding is the most valuable signal at the substrate (we
already paid AIMD's cost for it); latency is second; cost matters
but operators set `preferredTier` to drive it; static priority is a
last-resort tiebreaker.

**Cost score per tier.**
- `preferredTier = 'cheap'`: costScore = `1 - normalize(inputPerMtok)`.
  Cheaper = higher score.
- `preferredTier = 'premium'`: costScore = `0`. Operator chose
  premium because they want quality; cost stops being a signal.
- `preferredTier = 'normal'` or undefined: costScore = `0.5`
  (neutral).

**Why not pure shortest-queue?** Because `at_cap` is already binary.
Once we've filtered out at-cap endpoints, scoring within survivors
is meaningful — "least-busy of the affordable ones" is the win, not
"least-busy regardless of cost."

**Why not pure latency?** Because cold endpoints have undefined p50
and a pure-latency ranker has the cold-start problem of
unrepresentative samples. Mixing weights makes one sample
non-decisive.

### 4.3 Should kagent expose `kagent/auto` as a meta-model?

**Recommendation: yes, BUT make it explicit-tier-narrowed in the
URI namespace.** I.e. the model namespace looks like:

```
kagent/auto                        (any survivor; least-effort default)
kagent/auto/cheap                  (cheap-tier survivors only)
kagent/auto/premium                (premium tier)
kagent/<class>                     (class-filtered)
kagent/<class>/<tier>              (class + tier)

# concrete examples:
kagent/tool-capable
kagent/tool-strict/premium
kagent/vision/cheap
kagent/long-context

# explicit endpoint fallback (today's behavior):
anthropic/claude-sonnet-4-6
workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct
```

**Rationale.**
- A bare `kagent/auto` is too magic — it picks ANY endpoint, which
  in a multi-tenant cluster could mean the operator-paying-for-
  premium accidentally got routed to the homelab Ollama because it
  was idle. That's bad for cost; worse for reliability if the
  homelab box is offline.
- `kagent/auto/cheap` is meaningful: "I want any cheap-tier survivor."
  This is what most agent CRs should declare.
- `kagent/<class>` is meaningful: "I require this capability." This
  is what `outputContract.mode = tool-call` substrate-side resolves
  to (see §4.5).
- The exact-endpoint name (`anthropic/claude-sonnet-4-6`) stays
  available — back-compat with v0.1.

**Implementation cost.** ~80 lines: a `parseAutoModelName` function
that pattern-matches the URI into `(class | undefined, tier |
undefined, exact | undefined)`, threaded into the candidate-set
resolver in step 1 of §4.2.

**Anti-pattern to reject:** semantic / content-aware auto routing
(LiteLLM Auto Router, OpenRouter Auto via NotDiamond). Reasons:
- The substrate doesn't see prompt content in the way an embedding
  router needs it (and shouldn't — privacy posture).
- Embedding routing introduces a *second* LLM call per request
  (just to embed and pick), which doubles tail latency.
- Capability + cost-tier filtering is observably 90% of the value
  and 5% of the complexity.
- LiteLLM Auto Router itself is "BETA" as of v1.74.9; the cost
  hasn't been amortized yet.

### 4.4 User override surface — `Agent.spec.routingHints`

New optional CRD field on `AgentSpec`. Absent = today's behavior
(use whatever `spec.model` says, no hints).

```ts
export interface RoutingHints {
  /**
   * Required capability classes. The router MUST drop endpoints
   * that don't carry every listed capability. Resolved at request
   * time against the ModelEndpoint's static capabilities.
   *
   * Common values:
   *   - 'tool-capable'   — backend honors tools[].
   *   - 'tool-strict'    — backend honors tools[].strict.
   *   - 'vision'         — image inputs.
   *   - 'long-context'   — ≥ 200k window.
   */
  readonly requireCapabilities?: ReadonlyArray<
    'tool-capable' | 'tool-strict' | 'vision' | 'long-context' | 'cheap-tier'
  >;

  /**
   * Preferred cost tier. The router scores cheap-tier candidates
   * higher when set to 'cheap', neutralizes cost when 'normal',
   * disables cost-scoring when 'premium'. Default 'normal'.
   */
  readonly preferredTier?: 'cheap' | 'normal' | 'premium';

  /**
   * Allowed backends. If non-empty, the router DROPS endpoints
   * whose backendKind is not in the list. Useful for:
   *   - 'don't ship to a hosted provider': allowedBackends: ['ollama', 'localai']
   *   - 'must be on Bedrock for compliance': allowedBackends: ['bedrock']
   */
  readonly allowedBackends?: ReadonlyArray<ModelEndpointBackendKind>;

  /**
   * Stickiness — pin to the first-resolved endpoint for the
   * lifetime of the AgentTask (i.e. all requests within one task
   * use the same backendUrl). Defaults to true when the Agent's
   * outputContract.mode is 'tool-call' (because tool-cache re-
   * use across multi-step tool loops matters), false otherwise.
   */
  readonly stickyPerTask?: boolean;

  /**
   * Fallback policy on dispatch error.
   *   - 'on'   — auto-retry on next-highest-scored survivor (cap 2).
   *   - 'off'  — propagate the error, no retry.
   * Default 'on'.
   */
  readonly fallback?: 'on' | 'off';
}
```

Located on `AgentSpec`, parallel to `outputContract`. Threaded
through `AgentTask.spec.routingHintsOverride` (optional) so a
per-task override is possible (e.g. one task wants premium, the
rest cheap).

The agent-pod's runner reads the resolved hints, packs them into
`extra_body.routingHints` on each /v1/chat/completions call (kagent
extension over the OpenAI envelope), and the gateway honors them.

### 4.5 Hooking `outputContract.mode` into the router

Lookup table — the agent-pod (or the operator's admission webhook)
auto-derives `requireCapabilities` from `outputContract.mode`:

| `outputContract.mode` | Auto-derived `requireCapabilities` |
|---|---|
| `'tool-call'` | `['tool-capable']` (and `['tool-strict']` when `outputContract.strictMode === true`) |
| `'json'` with `outputContract.constrainedDecoding === true` | `['structured-output']` |
| `'json'` without strict | (none — best-effort retry-loop covers it) |
| `'free-text'` | (none) |

This makes the linkage automatic: an Agent CR that declares
`outputContract.mode: 'tool-call'` cannot be scheduled onto a
gateway whose only `ModelEndpoint`s are non-tool-capable. The
admission reconciler raises a clear error; the alternative is the
substrate silently failing every task on that Agent.

**Implementation point.** The auto-derivation lives in the
operator's `Agent` admission path (a webhook-style validation
during the existing reconcile loop), not in the gateway. The
gateway just enforces `requireCapabilities` whatever its source.
This means the agent-pod CAN bypass auto-derivation by setting
`requireCapabilities: []` in routingHints — useful for testing
"what happens if I let a non-tool-strict model try" without
changing the contract mode. Substrate doesn't policy-enforce this;
it's a knob.

### 4.6 Concrete file changes

| File | Change |
|---|---|
| `packages/operator/src/crds/types.ts` `ModelEndpointSpec` (lines 1129–1151) | Add `capabilities?: readonly string[]`, `cost?: { inputPerMtok, outputPerMtok }`, `priority?: number`. |
| `packages/operator/src/crds/types.ts` `AgentSpec` | Add `routingHints?: RoutingHints`. |
| `packages/llm-gateway/src/model-index.ts` | Replace `Map<modelName, ModelEndpoint>` with `Map<modelName, ModelEndpoint[]>` (multi-valued) PLUS a `Map<class, ModelEndpoint[]>` index for the auto-resolve path. New method `resolveCandidates(modelOrAuto, requireCaps, allowedBackends, tier): ModelEndpoint[]`. |
| `packages/llm-gateway/src/router.ts:111` | Replace single `lookup` with the §4.2 filter→score→pick pipeline. Keep AIMD bound update + in-flight counter as-is per chosen candidate. |
| `packages/llm-gateway/src/capability-table.ts` (new) | Static table of `(backendKind, modelPattern) → capabilities` for the inferred path. Override merges per-CR `spec.capabilities`. |
| `packages/llm-gateway/src/scoring.ts` (new) | Pure scoring function; trivially unit-testable. |
| `packages/llm-gateway/src/server.ts` | Parse `extra_body.routingHints` from the request envelope; thread to the router; strip from the upstream payload. |
| `packages/operator/src/reconcilers/agent.ts` | Auto-derive `RoutingHints.requireCapabilities` from `Agent.spec.outputContract.mode` if not set. |

Total LOC estimate: ~600 lines new + ~150 lines modified. Test
coverage budget: ≥85% on new modules per repo convention.

### 4.7 Migration story (back-compat)

- **`request.model = 'anthropic/claude-sonnet-4-6'`** (today's
  exact-name path): unchanged behavior. The
  `resolveCandidates(model)` call returns `[exact]` in step 1 and
  the rest of the pipeline is no-op for hard-filter / scoring
  (single survivor).
- **CRDs without `capabilities` set**: capability-table inference
  fills in. If the inferred set isn't enough for the request's
  `requireCapabilities`, the candidate gets dropped; operator sees
  a `capability_unavailable` 400 with the missing class enumerated.
- **AgentSpecs without `routingHints` set**: empty hints, no
  required capabilities, no backend filter. Auto-derivation from
  `outputContract.mode` runs anyway (so a tool-call Agent that
  forgot routingHints still gets the `tool-capable` filter).
- **`request.model = 'kagent/auto'`**: NEW affordance. Existing
  callers don't use it; only opt-in.

---

## 5. Open questions for Chris

These need explicit answers before §4 becomes implementation tickets.

### 5.1 Is `kagent/auto` (without an explicit class) even a good idea?

A bare `kagent/auto` lets operators write Agents without thinking
about capabilities. The cost: it's silent magic. An Agent that
declares `tool-call` mode but uses `kagent/auto` as its model
gets routed correctly (auto-derived caps), but reading the CR you
can't tell which model the substrate picks today.

**Two coherent positions:**
- **(a) Yes, allow `kagent/auto`.** Argues the auto-derivation
  from `outputContract` makes the silent magic safe, and the
  whole point of a substrate is to hide which-model-where.
- **(b) No, require `kagent/<class>` or an exact name.** Argues
  the substrate should make routing decisions explicit in the
  CR; if you want auto, name the class.

Recommendation: (a), because the substrate already hides AIMD
caps and backend URLs. Hiding model choice is consistent. But
you may want (b) for the "this is a substrate, force explicitness"
posture.

### 5.2 Default `preferredTier` — `'cheap'` or `'normal'`?

Homelab default leans `'cheap'` (the homelab Ollama box is the
likely first endpoint). Cloud-deployment default leans `'normal'`
(operator paid for Bedrock; using it).

The substrate doesn't know which deployment it's in. Three options:
- **Default `'normal'`.** Conservative. Operators on homelab
  override per-Agent.
- **Default `'cheap'`.** Optimistic. Cloud deployments override
  per-Agent.
- **Operator-config default in the gateway's `LlmGatewayConfig`,
  overridable per-Agent.** Most flexible; one extra config knob.

Recommendation: third option. The homelab manifests in
`new_localai/` set `defaultPreferredTier: 'cheap'`; cloud Helm
values default to `'normal'`.

### 5.3 Where does the `cost` block come from?

`ModelEndpointSpec.cost.{inputPerMtok, outputPerMtok}` lets the
router score cost. Two sources:

- **(a) Operator declares it per-CR.** Makes the CR self-contained;
  burdens the operator.
- **(b) Substrate ships a price-table (similar to LiteLLM's
  `model_prices.json`).** Easy operator, but the table goes stale
  every quarter as providers re-price. We'd need a release-cadence
  story.
- **(c) Both.** Substrate ships a default; operator overrides per-CR
  when a deal-pricing situation applies.

Recommendation: (c). Same shape as the capability inference —
substrate has reasonable defaults; operator overrides where
needed.

### 5.4 Privacy posture: should `routingHints.allowedBackends` default to anything?

In the homelab the default is "any of `[ollama, localai, exo,
cloudflare, openai, anthropic, bedrock]`." That's permissive — an
operator that copies an Agent CR and forgets to think about which
backends data flows to could ship their prompts to an external
API without realizing. The substrate could defend this by:

- Defaulting `allowedBackends` to local-only (`[ollama, localai,
  exo]`) and forcing the operator to opt into hosted backends.
- Defaulting permissive (today's posture).
- Computing the default from cluster annotations (e.g. a
  `kagent.knuteson.io/allow-hosted-backends` label).

Recommendation: NO substrate-side default. Permissive. The
substrate is not a data-loss-prevention tool — it's a router. DLP
is application-layer. Operators that want to enforce a privacy
posture set `routingHints.allowedBackends` per-Agent. Document
this clearly in the CRD comments.

### 5.5 Scoring weights — config-tunable or hard-coded?

§4.2 proposes `w_load = 0.4, w_latency = 0.3, w_cost = 0.2,
w_priority = 0.1`. Three positions:

- Hard-code. One less knob. If the weights are wrong, fix in code.
- `LlmGatewayConfig` env. Operator-tunable per cluster. Easy to
  tweak without a rebuild.
- Per-Agent. Each Agent sets its own weights. Maximally flexible;
  overkill.

Recommendation: `LlmGatewayConfig` env. Cluster-level operator
tuning, no per-Agent surface. If any one Agent needs to override,
they can use `routingHints.preferredTier` (which IS the high-level
weight knob, projected).

### 5.6 Does the gateway expose a `/v1/route-debug` endpoint?

For debugging "why did the gateway pick endpoint X over Y," it'd
be useful to have an endpoint that takes a `request.model` +
`requireCapabilities` and returns the candidate list with scores
without dispatching. Otherwise the only way to see is logs.

Trivial to ship (~30 LOC); fits the existing `/v1/snapshot`
pattern. Recommend yes.

### 5.7 Auto-fallback on `tool-call` failure — substrate or pod?

When `outputContract.mode: 'tool-call'` is set and the chosen
endpoint has `tool-capable` but NOT `tool-strict`, and the model
emits a free-text tool-call (the §1.2 RC failure), should the
SUBSTRATE auto-route the retry to a `tool-strict` endpoint, or
should the agent-pod's retry loop handle it?

- **Substrate-side.** Cleaner from the agent-pod author's view.
  Adds a "retry-on-output-contract-violation" router policy.
  Couples the router to verifier-style content awareness.
- **Pod-side.** Stays in `runOutputPipeline` per
  `RESILIENT-CONTRACTS.md` §4.2. Substrate is just a router.

Recommendation: pod-side. The `RESILIENT-CONTRACTS.md` retry budget
already handles this. The gateway doesn't need to interpret the
agent's loop semantics. But: the Agent CR can express "retry on a
DIFFERENT model" by setting `routingHints.requireCapabilities:
['tool-strict']` after the first failure — the substrate would
honor that. So the answer is "neither — let the pod re-call with
tighter caps."

---

## 6. Sources

- [OpenRouter Auto Router docs](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [OpenRouter announcements: New Auto Router](https://openrouter.ai/announcements/happy-new-year-introducing-a-new-auto-router)
- [Cursor docs — Selecting Models](https://docs.cursor.com/guides/selecting-models)
- [Cursor 4.7 Auto model selection — community thread](https://forum.cursor.com/t/cursor-4-7-auto-model-selection/70488)
- [GitHub Copilot Supported AI Models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [GitHub Copilot CLI — auto model selection](https://github.blog/changelog/2026-04-17-github-copilot-cli-now-supports-copilot-auto-model-selection/)
- [Continue.dev — Model roles intro](https://github.com/continuedev/continue/blob/main/docs/customize/model-roles/00-intro.mdx)
- [Continue.dev — YAML config / models[]](https://github.com/continuedev/continue/blob/main/docs/reference/yaml-migration.mdx)
- [Aider — Chat modes (architect/editor)](https://aider.chat/docs/usage/modes.html)
- [Aider — separating reasoning and editing](https://aider.chat/2024/09/26/architect.html)
- [LiteLLM — Router Load Balancing](https://docs.litellm.ai/docs/routing)
- [LiteLLM — Auto Routing (semantic, BETA)](https://docs.litellm.ai/docs/proxy/auto_routing)
- [LiteLLM — Tag-based Routing](https://docs.litellm.ai/docs/proxy/tag_routing)
- [LiteLLM — Routing & Load Balancing index](https://docs.litellm.ai/docs/routing-load-balancing)
- [LiteLLM v1.74.9 release notes — Auto-Router](https://docs.litellm.ai/release_notes/v1-74-9)
- [LiteLLM router.py source](https://github.com/BerriAI/litellm/blob/main/litellm/router.py)
- [AWS Bedrock Intelligent Prompt Routing](https://aws.amazon.com/bedrock/intelligent-prompt-routing/)
- [AWS Bedrock prompt routing user guide](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)
- [AWS::Bedrock::IntelligentPromptRouter CFN ref](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrock-intelligentpromptrouter.html)
- [Anthropic — Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
- [Anthropic — Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic strict tool use PR (LiteLLM)](https://github.com/BerriAI/litellm/pull/16725)
- [vLLM — Tool Calling](https://docs.vllm.ai/en/latest/features/tool_calling/)
- [Not-Diamond / awesome-ai-model-routing](https://github.com/Not-Diamond/awesome-ai-model-routing)
- [vLLM Semantic Router](https://vllm-semantic-router.com/)
