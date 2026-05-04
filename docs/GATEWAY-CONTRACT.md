# Model Gateway Contract

**Date:** 2026-05-03
**Status:** Draft, locks in pre-v0.2 integration boundary
**License:** MIT

> Read [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) for the substrate-level architecture this fits into. This document defines only the boundary between kagent's orchestration substrate and any external model gateway.

---

## 1. Purpose

kagent is the **orchestration substrate**: AgentTask lifecycle, capabilities, workspaces, content-addressed artifacts, supervision, audit. It owns *which* agent runs *what* with *what authority*.

A **model gateway** is the **model substrate**: routing across providers, PII handling, response caching, per-token quota, provider failover. It owns *how* a model call gets fulfilled.

The two are independently evolving systems connected by a small wire contract. This document is that contract.

```
┌──────────────────────────────────────────────────────────┐
│  kagent — orchestration substrate                         │
└──────────────────────────────────────────────────────────┘
                          │
                  OpenAI-compat HTTP
                  + W3C traceparent
                  + X-Kagent-* attribution
                  + bounded auth
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│  model gateway (any vendor / OSS / in-house)              │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                LLM providers (OpenRouter, OpenAI, Anthropic,
                self-hosted, Bedrock, ...)
```

A gateway is **kagent-compatible** if and only if it satisfies every MUST in this document.

---

## 2. Wire protocol

**MUST** speak OpenAI Chat Completions v1 over HTTP at a `/v1/chat/completions` endpoint.

**MUST** accept the OpenAI request body shape: `{model, messages, tools?, temperature?, max_tokens?, stop?, stream?, stream_options?, ...}`.

**MUST** return the OpenAI response body shape: `{id, object, created, model, choices, usage}`.

**MUST** stream via Server-Sent Events when `stream: true` and emit a terminal usage chunk when `stream_options.include_usage: true`.

**SHOULD** support `/v1/embeddings` if the substrate adopts embedding-using agents (currently not in v0.1; reserved for v0.3+).

The contract does NOT depend on which provider the gateway routes to. OpenRouter underneath, direct OpenAI, Anthropic-via-translation, on-prem — all equivalent from kagent's perspective.

### 2.1 Model selection

Agent CRs declare `Agent.spec.model: <name>`. The string is opaque to kagent — it's whatever name the gateway accepts on `request.body.model`. Common names: `gpt-4o`, `claude-3.5-sonnet`, `openrouter/anthropic/claude-3.5-sonnet`.

The gateway **MAY** route a logical model name to any physical provider, but **SHOULD** report the actual model in `X-Model-Used` (see §5).

---

## 3. Required request headers

kagent stamps the following headers on every outbound `/v1/chat/completions` call. The gateway:

- **MUST** accept and ignore (forward, log, drop) without rejecting the request.
- **SHOULD** record them in its own logs / metrics for cross-system attribution.
- **SHOULD** propagate `X-Kagent-Task-UID` to upstream LLM calls if the upstream supports it (most don't; safe to drop).

| Header | Required | Source | Use |
|---|---|---|---|
| `Authorization: Bearer <token>` | yes | kagent operator config or per-Agent capability bundle | Gateway authentication |
| `Content-Type: application/json` | yes | OpenAI spec | — |
| `X-Kagent-Task-UID` | yes (post-v0.1.7) | `KAGENT_TASK_ID` (= AgentTask UID) | Cross-system join key |
| `X-Kagent-Agent` | yes (post-v0.1.7) | `KAGENT_AGENT_NAME` | Per-Agent attribution |
| `X-Kagent-Tenant` | yes (post-v0.5.0) | resolved from AgentTask namespace + Tenant CR | Per-tenant routing/quota |
| `X-Kagent-Capability-Id` | yes (post-v0.3.0) | capability bundle JTI | Audit trail join key |
| `X-Idempotency-Key` | yes (post-v0.2.0) | `AgentTask.spec.idempotencyKey` | At-most-once execution; gateway cache key |
| `traceparent` | yes (when OTel wired) | W3C Trace Context | Distributed trace assembly |
| `tracestate` | optional | W3C Trace Context | — |

Gateway **MUST NOT** echo `Authorization` in any response body, log line, or trace attribute.

---

## 4. Authentication

The contract is auth-mechanism-agnostic but assumes **bearer token** on `Authorization`. Mechanisms supported (gateway picks one):

### 4.1 Single shared token (v0.1)

One operator-wide token, sourced from a K8s `Secret` via `secretKeyRef`, threaded into every spawned agent-pod via `KAGENT_LITELLM_API_KEY`. Simple, leaks if the token is compromised, fine for OSS/dev/single-tenant.

### 4.2 Per-Agent token (v0.3+, capability bundles)

Each Agent gets its own gateway token, scoped via the gateway's own org → tenant → key hierarchy. The capability bundle issued for an AgentTask carries the appropriate token. Spawning narrows: a child's token has model-whitelist ⊆ parent's. Eliminates plaintext token sharing across agents.

This composes with the gateway's existing key model:

```
Org (kagent installation)
└── Tenant (kagent Tenant CR; v0.5.0)
    └── Key (per-Agent; v0.3.0)
        └── Model whitelist (subset of tenant's, subset of org's)
```

**Implementation note (per gateway team):** kagent's CR-driven key issuance is optional; a single-tenant kagent deploy can keep using one shared key forever. The substrate adapts to either.

### 4.3 mTLS / SPIFFE (v0.4.3+)

Per-pod SVID, gateway authenticates by client cert. Eliminates bearer tokens entirely. Gateway **MAY** support but contract does not require.

### 4.4 OAuth client-credentials

Equivalent shape to per-Agent token (§4.2); just with token issuance via OAuth flow rather than direct K8s `Secret`. Gateway **MAY** support; not required.

---

## 5. Required response headers

Gateway **SHOULD** emit these so kagent can record cross-system attribution and routing decisions in traces.

| Header | Recommended | Use |
|---|---|---|
| `X-Model-Used` | yes | Logical → physical model resolution. Routes to trace metadata. |
| `X-Cache-Status` | yes | `hit \| miss \| stale \| bypass`. Routes to trace; complements kagent's CAS layer. |
| `X-Provider` | optional | Provider identity (`openai`, `anthropic`, `openrouter:anthropic/...`). Audit. |
| `X-Request-Id` | yes | Gateway-side request identity. Joins with kagent's task UID for incident response. |
| `X-PII-Action` | when applicable | `scrubbed \| blocked \| none`. Trace metadata. |
| `Retry-After` | required on 429/503 | Backpressure semantics (§7). |

---

## 6. Distributed tracing

Gateway **MUST**, by v0.4.0:

1. Read incoming `traceparent` per [W3C Trace Context](https://www.w3.org/TR/trace-context/).
2. Emit OTLP child spans for its internal stages — at minimum `gateway.request`, `gateway.scrub` (when applicable), `gateway.cache_lookup` (when applicable), `gateway.upstream_call`.
3. Set OTel `gen_ai.*` semconv attributes on the upstream-call span (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.{input,output}_tokens`).
4. Ship spans to the same OTLP collector kagent does (Langfuse-compatible OTLP/HTTP).

**Until §6 is implemented:** kagent emits only its own client-side span around the gateway call. The trace tree shows a single "gateway call" leaf. PII scrubbing decisions, cache hits, and provider routing are invisible. Functional but degraded observability.

**The PII / trace boundary** is critical: the trace span attribute capturing the request body is set on the **kagent** side, **before** the gateway sees the bytes. If `KAGENT_TRACE_CONTENT_MODE=full`, the pre-scrub body lands in Langfuse — same surface as today. The gateway's own scrub spans capture the *post-scrub* view. Operators choose: trace what the agent *intended* to send (kagent side, full mode) vs. what *actually* went to the LLM (gateway side). Both are valid; the contract just makes them distinguishable.

---

## 7. Backpressure

Gateway **SHOULD** respond `429 Too Many Requests` with `Retry-After: <seconds>` when:

- Per-key quota exceeded
- Per-tenant quota exceeded
- Upstream provider rate limit observed

Gateway **SHOULD** respond `503 Service Unavailable` with `Retry-After: <seconds>` when an upstream is unhealthy and gateway is failing-over.

kagent agent-pod behavior on 429/503:

1. Sleep `min(Retry-After, runConfig.timeoutSeconds_remaining)`.
2. Retry up to `runConfig.maxRetries` (default 3, capped at remaining wall-clock).
3. If still failing, surface `LLMClientHttpError` to the executor; the run terminates `Failed` with structured cause.

**Until §7 is implemented:** kagent falls back to operator-side admission via `ModelEndpoint.spec.inFlight.{seed,max}`. Coarse-grained but functional. Once gateway adds proper backpressure, ModelEndpoint cap becomes a safety belt rather than the primary throttle.

---

## 8. PII handling

PII policy is gateway-resident; kagent expresses *which* policy to apply per-request, not *how* to apply it.

Gateway **SHOULD** support a per-request mode header:

```
X-PII-Mode: scrub | block | passthrough
```

| Mode | Behavior on PII detect | kagent action on response |
|---|---|---|
| `scrub` | Replace with `[REDACTED]`, forward to LLM | Continue normally; trace `X-PII-Action: scrubbed` |
| `block` | Return 422 with structured body | Terminate run `Failed`, audit event with PII flags |
| `passthrough` | Forward unmodified | Continue normally; trace flag only |

Default mode: chosen by gateway (per-tenant policy is a sensible default).

**Open question for the gateway team:** should the 422-on-block body include *which* PII categories matched, or just the count? kagent treats it opaquely, but enterprise audit requirements may want the categories.

kagent expression (v0.3+): `Agent.spec.piiMode` overrides the default per-Agent.

---

## 9. Idempotency

Gateway **SHOULD** treat `X-Idempotency-Key` as a cache key, scoped to `(key, model, hash(messages))`.

- Same key + same input → return cached response (with `X-Cache-Status: hit`).
- Same key + different input → 409 Conflict with descriptive body.
- TTL: gateway-defined (24h is typical).

This is a coordination point, not a hard requirement. kagent's CAS layer caches at the agent-run level (entire task replays); gateway caches at the LLM-call level. **Same idempotency key flowing through both layers gives end-to-end at-most-once execution** — even across kagent restarts, gateway restarts, or network partitions.

---

## 10. Error semantics

Standard OpenAI error envelope:

```json
{ "error": { "type": "...", "message": "...", "code": "..." } }
```

kagent agent-pod treats:

- `400 invalid_request_error` → executor `LLMClientHttpError(400, ...)`. Run fails. No retry.
- `401 / 403` → `LLMClientHttpError(401|403, ...)`. Run fails. No retry. Audit event flagged for credential review.
- `404 model_not_found` → `LLMClientHttpError(404, ...)`. Run fails. Operator emits `Event` on the AgentTask.
- `422 pii_blocked` (custom code via the `code` field) → terminate `Failed`, audit event with categories.
- `429` / `503` → backpressure path (§7).
- `5xx` (other) → up to `runConfig.maxRetries` with exponential backoff.

Gateway **SHOULD NOT** wrap upstream provider errors opaquely — the OpenAI envelope is sufficient; provider details belong in `error.message`.

---

## 11. Out of scope

The contract intentionally does NOT specify:

- **Routing logic.** Gateway picks providers per its own policy.
- **Cache eviction.** Gateway-internal.
- **Quota policy.** Gateway-internal; kagent only sees 429.
- **Provider failover.** Gateway-internal; kagent only sees response.
- **Prompt injection defense.** Gateway-internal; kagent's substrate-side defense is detector middleware (F1/F2/F3).
- **Embeddings semantics** (until v0.3 introduces embedding-using agents).
- **Function calling translations.** Tools are passed through verbatim per OpenAI spec.

These are gateway-vendor differentiators. The contract stays small so any gateway — your enterprise one, LiteLLM, OpenRouter directly, a cloud-provider-managed one — can implement it.

---

## 12. Compatibility matrix (current)

| Gateway | OpenAI compat | traceparent | 429/Retry-After | X-Model-Used | PII modes | Idempotency |
|---|---|---|---|---|---|---|
| `@kagent/llm-gateway` (bundled OSS) | yes | partial | partial | no | no | no |
| LiteLLM Proxy | yes | partial | yes | yes | no | no |
| OpenRouter direct | yes | no | yes | yes (`x-or-...`) | no | no |
| **Enterprise gateway (CTK)** | **yes** | **planned** | **planned** | **planned** | **yes (configurable)** | **planned** |

Enterprise gateway team: §6 (traceparent + OTLP), §7 (429 + Retry-After), §9 (idempotency) are the four gaps. None is structurally large. §6 unlocks unified observability; §7 unlocks proper substrate backpressure; §9 unlocks at-most-once across both layers.

---

## 13. Versioning + change policy

This contract is versioned semver via the `kagent` repo. Breaking changes require:

1. RFC PR proposing the change.
2. Two-release deprecation window with both old + new accepted.
3. Compatibility matrix update.

Forward-compatible additions (new optional headers, new modes) ship in minor releases without notice.

The contract is the *only* coupling between kagent and any model gateway. Anything outside this document is implementation detail and may change unilaterally.
