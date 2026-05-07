# Protocols — kagent's interop posture

**Date:** 2026-05-06
**Status:** Strategic map, post-audit. Frames the slate that follows the v0.1.9 context-awareness work.
**Owner / scope:** substrate-level. No new CRDs in this doc — it's the map that decides which protocol slates land next and in what order.

> Read [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) (the 7 primitives + 3 cross-cutting concerns), [`AUDIT-2026-05-06.md`](./AUDIT-2026-05-06.md) (the strategic context — R1 falsified the "only OSS K3s-native" framing; R2 flagged A2A as the highest-leverage strategic gap), [`UPSTREAM-DIFF-AGENT-SANDBOX.md`](./UPSTREAM-DIFF-AGENT-SANDBOX.md) (Path 1 = adopt + extend), and [`CONTEXT-AWARENESS.md`](./CONTEXT-AWARENESS.md) (the just-shipped substrate-thin context-handling design) first.
>
> This doc is the **interop map**: where do agents speak to other things, what protocols exist, what does kagent ship today vs. what's the gap. Frames the strategic positioning Option 2 from the audit ("compete on composition") with **compat-as-a-feature** as the marketing surface.

---

## 1. The thesis: compat is a feature

The audit (R1, R2) found that kagent's competitive position is NOT novelty — the upstream Kubernetes SIG owns the per-agent isolation primitive (`kubernetes-sigs/agent-sandbox`), Cloudflare ships ten more substrate primitives than kagent has even sketched, and Anthropic Managed Agents has converged on the same Agent/Environment/Session triple kagent picked. **What kagent CAN own** is composition + interop: be the substrate that speaks every relevant protocol on the wire so consumers can swap in / out without forking.

The strategic shift implied:

- **Stop:** marketing kagent as "the only X."
- **Start:** marketing kagent as "the substrate that speaks A2A v1.0 + MCP server + MCP client + OTel GenAI semconv + GATEWAY-CONTRACT + SPIFFE + CloudEvents — out of the box, on K3s."

Every protocol slate that follows from this doc earns its keep on **a single test:** does adopting it make kagent compatible with a real production-deployed system that today requires a custom adapter? If yes, ship. If no, defer.

---

## 2. The four layers where agents communicate

Most "agent communication" conversations conflate four distinct boundaries. Each has its own protocol stack, maturity, and gap profile:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1 — In-process: model ↔ tools ↔ memory ↔ trace          │
│  Inside one agent loop in one pod. The "intra-agent" layer.     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2 — Pod-to-substrate: agent-pod ↔ operator               │
│  CRD reads/writes, lifecycle events, audit emission.            │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3 — Inter-agent (peer-to-peer): pod ↔ pod                │
│  The "A2A" layer. Pub/sub events, task delegation, handoff.     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Cross-system: agent ↔ external services              │
│  HTTP egress, gateway calls, identity to non-kagent peers.      │
└─────────────────────────────────────────────────────────────────┘
```

Each layer below is mapped in three columns: **what protocols exist in the wider OSS world**, **what kagent ships today** (with file:line where useful), and **where the gap is**.

---

## 3. Layer 1 — In-process (intra-agent)

The model talks to tools talks to (maybe) memory talks to the trace sink. All within one agent loop in one pod.

### 3.1 Tool provisioning

| Protocol | Status | kagent posture |
|---|---|---|
| **MCP (Model Context Protocol)** — Anthropic-originated, broadly adopted standard for tools/resources/prompts | Dominant standard as of 2026 | ✅ **Consumes via `@kagent/mcp-tool-provider`.** The agent-pod can speak MCP to any registered MCP server. |
| **OpenAI tool calling** (function_call / tool_calls JSON shape) | The wire format the LLM emits | ✅ Standard via `@kagent/openai-compat`. |
| **OpenAI Apps SDK** — extends MCP for ChatGPT-native apps | Distribution channel, not a substrate concern | ❌ Out of scope (consumer-app shape, not substrate). |
| **MCP Servers Registry** | Emerging discovery layer (early 2026) | ❌ Not wired. Worth tracking; plausible v0.2+ slot. |

**Gap:** kagent **does not expose AgentTasks AS MCP-callable tools** — i.e., kagent is an MCP *client*, not an MCP *server*. Cloudflare Workers and Anthropic both ship this pattern: an external Claude Code instance calls your kagent-hosted researcher agent via MCP. **This is the highest-leverage Layer 1 win and it's structurally small** — see §7 slate "MCP-server-out."

### 3.2 Memory / persistent agent state

| Protocol | Status | kagent posture |
|---|---|---|
| **Letta / MemGPT** — hierarchical memory with summarization | Framework primitive | ❌ Not adopted. |
| **mem0** — emerging memory layer | Framework primitive | ❌ Not adopted. |
| **Zep** — temporal memory with knowledge graphs | Framework primitive | ❌ Not adopted. |
| **Anthropic Managed Agents Memory** | Cloud-locked | ❌ Not applicable. |
| **Cloudflare DO-SQLite-per-agent** | Cloud-locked | ❌ Not applicable. |
| **kagent Artifact (`cas://sha256:...`)** — content-addressed bytes, sha256-URI | Planned v0.2.2-cas; backend in `packages/agent-pod/src/cas-backend.ts` | ✅ **This IS kagent's cross-task persistence story.** The earlier audit's mention of "no memory primitive" was a category error — artifacts ARE the memory story for the substrate. |
| **kagent Workspace** — RWX-PVC scratch FS, pipeline-scoped | Planned v0.2.1-workspaces | ✅ Sibling primitive to artifacts (Workspace = mutable scratch; Artifact = immutable named bytes). |
| **kagent Blackboard** — task-tree-scoped typed KV (NATS JetStream KV bucket) | Shipped (`packages/blackboard/`) | ✅ For sibling-coordinated state within one task tree. |

**Gap (corrected from earlier sketch):** kagent has THREE persistence primitives (Workspace mutable FS, Artifact immutable CAS, Blackboard typed KV) — together they are the equivalent of a build pipeline's storage stack. **What's missing is not memory itself; it's the standardized envelope an expiring agent uses to hand off REFERENCES to those primitives to its successor** — see §6.

### 3.3 Trace / observability

| Protocol | Status | kagent posture |
|---|---|---|
| **OpenTelemetry GenAI semconv** (`gen_ai.*`) | The dominant standard | ✅ Shipped. `@kagent/trace-sinks` `OtelTraceSink` emits the full set per Phase 4.x bullet (`v0.1.7-rig.2`). |
| **OpenInference** (Arize-led OTel extension) | Compete-with semconv | ❌ Not adopted. The user-facing distinction is small; OTel-vanilla is the right bet. |
| **OpenLLMetry** (Traceloop-led OTel extension) | Compete-with semconv | ❌ Not adopted. Same reasoning. |
| **Langfuse OTLP/HTTP ingest** | Backend, not protocol | ✅ Shipped. Default sink target. |

**Gap:** the trace shape is correct AND the audit's verifier-label-collision BLOCKER was fixed. No protocol-level work needed at this layer beyond v0.1.

### 3.4 In-process budget + capability inspection

| Protocol | Status | kagent posture |
|---|---|---|
| **`get_my_context` substrate tool** — read-only introspection of taskUid / agentName / depth / budget / cap claims / **token utilization** | Substrate-internal | ✅ Shipped (cap claims) + extended in v0.1.9 context-awareness slate (token utilization). |
| **`get_my_capability` analog** | Not yet a separate tool | ✅ Folded into `get_my_context` via the `capability` field. |

No external standard here; the surface is intentionally substrate-internal.

---

## 4. Layer 2 — Pod-to-substrate

The agent-pod talks to the operator through K8s primitives, NATS, and audit events.

| Protocol | Status | kagent posture |
|---|---|---|
| **Kubernetes CRD status subresource** (REST PATCH) | The K8s-native channel | ✅ Used. `packages/agent-pod/src/status.ts` writes via merge-patch. (Audit C2 HIGH #3 flagged the lack of `resourceVersion` precondition — to be addressed.) |
| **CloudEvents v1.0 over NATS JetStream** (`audit` stream) | The signed-event substrate channel | ✅ Shipped. `@kagent/audit-events` emits `task.admitted`, `capability.minted`, `secret.accessed`, etc. |
| **NATS JetStream subjects** (operator → agent direction) | Native pub/sub | ⚠ Operator publishes via `NatsDispatcher`; in-pod subscription deferred. Adequate for v0.1, gap for streaming-cancel. |

**Gap:** none load-bearing for compat. The Layer 2 surface is intentionally K8s-native; nobody else is going to consume it directly.

---

## 5. Layer 3 — Inter-agent (peer-to-peer)

This is the layer most people mean by "agent communication." It is also where kagent's biggest interop gap lives.

### 5.1 Wire-format protocols for agent-to-agent task exchange

| Protocol | Status | kagent posture |
|---|---|---|
| **A2A v1.0** — Linux Foundation (Agentic AI Foundation), GA [March 12 2026](https://a2a-protocol.org/latest/announcing-1.0/), signed agent cards, task lifecycle, [150+ orgs in production](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations) via Vertex / AgentCore / Foundry as of the LF anniversary (April 9 2026). Version sequence v0.3 → v1.0 (no v1.1 / v1.2 has shipped). Hosted by the Linux Foundation under the [Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation), formed Dec 9 2025. | **The dominant standard.** | ❌ **Not on the wire.** kagent's NATS subjects are an ad-hoc envelope shape; an agent on Vertex / Foundry / AgentCore cannot trade tasks with a kagent agent without a custom adapter. **#1 gap by leverage.** |
| **AGNTCY** (Cisco-led "Internet of Agents") | Aspirational; smaller production footprint | ❌ Watch but don't bet on. |
| **ANP (Agent Network Protocol)** | Open identity + messaging proposal | ❌ Not adopted. Possibly redundant with A2A + SPIFFE. |
| **ACP (Agent Communication Protocol)** | IBM Research adjacent | ❌ Not adopted. |
| **NLIP (Natural Language Interaction Protocol)** | Newer entrant | ❌ Watch. |

### 5.2 Workflow durability protocols (Layer 3 orchestration)

| Protocol | Status | kagent posture |
|---|---|---|
| **Restate** | Pluggable durable execution backend | ✅ Picked as AgentWorkflow backend (planned v0.3.2-workflows). |
| **Temporal Nexus** | Production-dominant durable workflow | ❌ Not adopted; Restate was chosen. Worth keeping a watching brief because Temporal Cloud + self-host are both real production options. |
| **Inngest / Trigger.dev v3** | Cloud-first durable workflow runners | ❌ Not adopted. |

### 5.3 The handoff envelope (the substrate-shaped gap)

There is **no broadly-adopted standard** for "expiring agent passes references to the artifacts/blackboard-keys/NATS-subjects/cap-JTI/parent-task-uid that its successor needs to resume." OpenAI Agents JS has handoffs as a class concept; CrewAI has tasks; Mastra has workflows; A2A v1.0 has task lifecycle but not a *content* envelope.

This is the gap to fill — and the user's framing in the design conversation that prompted this doc is the right one: **the handoff envelope carries references, not content**. See §6.

---

## 6. The handoff envelope — references, not content

> Inspired by the user's observation: *"feels like we could simply hand off references to 'memory/tool pods/whatever' between expiring agents/new peers/subagents."* That is exactly the right design.

### 6.1 The anti-pattern (what NOT to do)

`AgentTask.spec.parentDistillation` is deprecated in v0.2.0-typed-io for good reason: **it carried CONTENT** (a free-form summary string), which (a) had no size cap and could blow ARG_MAX, (b) was opaque to the substrate, (c) couldn't be verified, and (d) reproduced the env-JSON ConfigMap leak surface the I/O sub-team just fixed.

Auto-compaction (substrate summarizes the conversation) has the same shape of failure — substrate becomes responsible for compaction quality, which is application-shaped (per `CONTEXT-AWARENESS.md` §2).

### 6.2 The shape that works

A reference-passing envelope. The handing-off agent declares:

```jsonc
{
  "kagent.io/handoff/v1": {
    "reason": "context_pressure",                 // or "deadline_imminent", "max_iterations_reached", "user_explicit"
    "parentTaskUid": "abc-123",
    "iterationsCompleted": 14,

    // What the parent READ (so successor knows the input set):
    "inputs": [
      { "name": "corpus",   "ref": "workspace://seekarc-pr-1234" },
      { "name": "brief",    "ref": "cas://sha256:abc.../brief.md" }
    ],

    // What the parent PRODUCED so far (successor picks up here):
    "intermediateArtifacts": [
      { "name": "topic-summary-rust",     "ref": "cas://sha256:def.../rust.md",     "writtenAt": "..." },
      { "name": "topic-summary-k8s",      "ref": "cas://sha256:ghi.../k8s.md",      "writtenAt": "..." }
    ],

    // What the parent's blackboard state looks like at handoff time:
    "blackboardKeys": ["plan", "next-action", "pending-research-urls"],

    // Capability bundle delegation: successor inherits a NARROWED cap (substrate-enforced):
    "capabilityRef": "cap-jti-xyz789",            // operator mints fresh cap for successor; ⊆ parent's

    // The OPTIONAL hand-written brief — bounded, schemaable, not free-form sprawl:
    "brief": {
      "summary": "...",                           // ≤ 1024 chars; longer goes in an artifact
      "todoNext": ["summarize postgres MVCC", "synthesize all 3 into final"],
      "skipFurtherResearch": true                 // structured signals the successor's prompt can branch on
    },

    // Optional: NATS subject continuation — successor subscribes here for in-flight events:
    "subjectContinuation": "agent.task.abc-123.continuation"
  }
}
```

The substrate's role:

- **Validates the envelope shape** at admission (size caps; URI scheme conformance; cap narrowing).
- **Mints the successor's cap** as `parent.cap ∩ requested.cap` (the existing capability primitive, already enforced).
- **Refuses the handoff** if the successor's declared input refs are unreadable from the cap's `read` claims.
- **Audits the handoff** (`task.handed_off` event on the audit stream).
- **Does NOT summarize.** The `brief` is hand-written by the parent agent's LLM; the substrate doesn't fill it.

The successor agent's role:

- Reads the envelope at boot (it's `AgentTask.spec.handoff` — a new optional field).
- Decides what to read first (substrate doesn't pre-fetch; the agent's prompt drives ordering).
- Optionally subscribes to the continuation subject if it needs streaming events from peers.

### 6.3 Why this composes cleanly

- **No content in the envelope above 1KB.** Bigger artifacts = write to CAS, pass URI. Same discipline that prevents env-JSON ARG_MAX blowup.
- **Substrate-side cap narrowing already exists** (the v0.1.8 capability slate) — handoff just reuses the cap-mint-narrowed-on-spawn primitive.
- **Substrate-side audit emission already exists** — one new event type.
- **Substrate-side input validation already exists** (`AgentTask.spec.inputs[]` admission, v0.2.0-typed-io) — handoff inputs go through the same gate.
- **Auto-detection from context-awareness slate already exists** — when `tokenUtilization.percentage > 0.9`, the agent's prompt knows to populate the envelope and call the (new) `handoff_to_self` tool.

### 6.4 When this lands

After the v0.1.9 context-awareness slate ships and the A2A wire (next-up; see §7) lands. Tag candidate `v0.2.5-handoff` slot in [`ROADMAP.md`](./ROADMAP.md). It's a small slate (one CRD field, one substrate tool, one validator, one audit event) and is the "Slate 3" candidate in §7.

---

## 7. Layer 4 — Cross-system

Identity + auth between kagent and external services.

| Protocol | Status | kagent posture |
|---|---|---|
| **OAuth 2.1** + scopes | The classic | ⚠ Used by the bundled `@kagent/llm-gateway` for admin token auth. Per-Agent OAuth not wired. |
| **GNAP (Grant Negotiation and Authorization Protocol)** | Newer flexible auth | ❌ Watch. |
| **macaroons** / **biscuit tokens** — caveat-narrowing | Theoretical / niche production | ➡ kagent's JWT cap-narrowing is conceptually in this family. Worth writing as a public RFC-shaped doc (see §8 slate 5). |
| **SPIFFE SVID + mTLS** | The K8s-native identity standard | ⚠ Planned `v0.4.3-identity`; probe-only client today (`packages/agent-pod/src/svid-client.ts`). |
| **GATEWAY-CONTRACT.md** | kagent's own | ✅ Shipped. The wire contract between kagent and any LLM gateway. |

**Gap:** SPIFFE finalization is the natural Layer 4 work, but its punchlist line is already on the audit (M7).

---

## 8. The recommended slate order (post-v0.1.9-context-awareness)

Each slate has the same shape: small, file-scoped, additive, single-PR-shippable.

> **Slate ordering revised (rev3, 2026-05-07).** Per `evidence/audit-rev3/R2.md` §5.3 and STRATEGIC S-RE-ORDER, the rev2 ordering (A2A wire first, cap-narrowing RFC fifth) was wrong. The rev3 pressure-test of the rev2 "12-month moat" claim found the moat is closer to **4-7 months for the "no one else has this" framing**; the contribution-back path is the only way to convert that uniqueness window into permanent positioning at SIG Apps. Once the SIG-Apps gap closes (a competitor lands a capability primitive upstream first, or the SIG ships its own shape), the moat ages out regardless of how fast the substrate ships A2A. Therefore: **ship the cap-narrowing RFC FIRST as Slate 1**; A2A wire moves to Slate 5. The implementation specs of the other slates do not change; only the ordering and rationale.

### Slate 1 — Capability narrowing as a public RFC (`v0.2.3-cap-rfc`)

**Why first (rev3):** the contribution-back path is the only way to convert a 4-7-month moat into permanent positioning at SIG Apps. Per `evidence/audit-rev3/R2.md` §3.1 Path 4, an accepted KEP-shape contribution is 6-12 weeks to land — and it locks the moat upstream. The SIG-Apps gap is uncontested today (zero open issues on capability/identity/JWT/SPIFFE in `kubernetes-sigs/agent-sandbox` per rev3 R1 §1.2(i)); it will not stay uncontested. A2A wire is bridge-able after the fact (slate 5 below); capability narrowing is harder to retrofit if someone else ships the standard first.

**What lands:** `docs/RFC-CAPABILITY-NARROWING.md` (already drafted) opened as a discussion issue + (if traction lands) KEP draft on `kubernetes-sigs/agent-sandbox`. Reference implementation extracted from `packages/operator/src/cap-issuer.ts` and `packages/agent-pod/src/cap-consumer.ts` into a standalone MIT library suitable for SIG adoption.

### Slate 2 — MCP-server-out (kagent agents AS MCP-callable tools) (`v0.2.4-mcp-server-out`)

**Why second:** simple + big interop win per user's framing. External Claude Code or any other MCP client can call a kagent-hosted researcher / summarizer / verifier as a tool.

**What lands:**
- Workbench-api gains an MCP-server endpoint at `/mcp/v1` (per the MCP spec). Each Agent CR's `spec.exposeAsTool: true` toggle makes the Agent visible as an MCP tool, callable as `kagent.<agentName>`.
- Calls flow: MCP client → workbench-api MCP endpoint → POST /api/tasks (existing path) → operator dispatches agent-pod → result returns synchronously (or async via the MCP sampling shape).
- Auth: existing X-Forwarded-User OR a scoped MCP API key (mintable via the existing `POST /admin/keys` shape).
- Cap narrowing: each MCP call materializes a one-shot AgentTask with a narrowed cap derived from the MCP key's claims.

**What does NOT land:** MCP-server-out is a sync facade over the async AgentTask machinery; the sampling / streaming MCP shapes can wait for v0.3+.

### Slate 3 — Reference-passing handoff envelope (`v0.2.5-handoff`)

**Why third:** depends on slate 5 (the envelope format should be A2A-task-lifecycle-shaped where possible) and slate 2 (the agent that picks up the handoff might be reached via MCP). Closes the long-running-agent loop the v0.1.9 context-awareness slate started.

**What lands:** per §6.

### Slate 4 — In-pod NATS subscription (`v0.2.6-in-pod-nats`)

**Why fourth:** unblocks streaming-cancel, real-time peer notifications, and the subjectContinuation field of the handoff envelope. Today the agent-pod can publish but not subscribe; this finishes the bidirectional A2A bus.

**What lands:** `@kagent/agent-pod-nats-subscriber` adapter, lifecycle-managed by the agent-pod main loop, gated behind the same cap.subscribe claim as `subscribe_event`.

### Slate 5 — A2A v1.0 wire format on the Event primitive (`v0.2.7-a2a-wire`)

**Why fifth (rev3):** still the highest interop leverage; today kagent agents are an island and with this slate they trade tasks with [150+ production deployments using A2A](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations) (LF anniversary count, April 9 2026). Demoted from rev2's slate 1 because (a) the cap-narrowing RFC has a tighter SIG-Apps window (rev3 R2 §3.1 Path 4) and (b) A2A wire is still bridge-able after the fact whereas cap-narrowing is not. See `docs/A2A-IMPLEMENTATION-PLAN.md` §4 for the implementation architecture decision (Option A bridge vs Option D in-pod transparent-proxy server).

**What lands:**
- New `@kagent/a2a` package — [A2A v1.0](https://a2a-protocol.org/latest/announcing-1.0/) envelope encoder/decoder (typed, zod-validated).
- New `Agent.spec.a2aCard` field — the signed agent card per the A2A spec.
- `publish_event` and `subscribe_event` tool wiring extended to optionally accept/emit A2A-shaped envelopes (gated by an env flag for back-compat).
- Operator emits the agent card on Agent CR admission; serves it at a well-known URL.

**What does NOT land:** kagent doesn't become an A2A registry server (that's a separate decision). NATS stays the transport; A2A is the message shape on top.

---

## 9. The compat-as-a-feature framing

Each slate's marketing line maps to a specific real system that today requires custom adaptation:

| Slate | "Now compatible with…" | Concrete demo |
|---|---|---|
| 1 — Cap narrowing RFC | (No one yet — kagent is the reference; SIG-Apps contribution-back) | k8s-sigs RFC discussion; SIG Apps decides; if accepted, kagent's narrowing primitive becomes the upstream-blessed shape. |
| 2 — MCP-server-out | Claude Code / any MCP client | An external Claude Code instance lists kagent agents as tools, calls one, gets a result. |
| 3 — Handoff envelope | Long-running agentic workflows that span days | A research session spans 5 chained handoffs over 12 hours; a single Workbench task graph view shows the chain; no manual YAML in between. |
| 4 — In-pod NATS subscribe | Real-time agent meshes; streaming cancel | An operator cancels a parent task; all in-flight children receive the signal within 1s. |
| 5 — A2A wire | Vertex / AgentCore / Foundry / 150+ A2A-speaking agents | A kagent researcher receives a task from a Vertex orchestrator, completes it, returns A2A-shaped result. |

The shift from "kagent is the only X" to "kagent is the substrate that speaks Y, Z, and W out of the box" is the thing this doc commits to. **Compat is not a defensive crouch — it's the offensive play.** The audit's R1 finding makes the defensive crouch unviable; this slate stack makes the offensive play concrete.

---

## 10. What this doc explicitly does NOT commit to

- **kagent does NOT become a registry/discovery service.** A2A clients discover kagent agents via the workbench-api's well-known agent-card URL, not via a kagent-hosted directory.
- **kagent does NOT become an OAuth provider.** External auth integrations stay on the consumer side (oauth2-proxy in front of workbench-api remains the recommended path).
- **kagent does NOT add a memory primitive separate from artifacts/workspace/blackboard.** The three existing persistence primitives + the handoff envelope (slate 3) cover the cross-task / cross-handoff state story. If a real consumer demands a fourth shape (e.g., per-Agent-identity time-keyed memory), revisit then.
- **kagent does NOT speak ANP / ACP / AGNTCY in the substrate.** Those can be application-layer adapters if a real consumer needs them. A2A v1.0 is the bet.
- **kagent does NOT add an MCP-server-IN beyond what `@kagent/mcp-tool-provider` already does.** That layer is shipped.

---

## 11. Cross-references

- `docs/SUBSTRATE-V1.md` — the 7 primitives the protocol slates compose with
- `docs/AUDIT-2026-05-06.md` R2.3 — A2A as the highest-leverage strategic gap
- `docs/AUDIT-2026-05-06-PUNCHLIST.md` H4 — A2A item, now slate 1 above
- `docs/UPSTREAM-DIFF-AGENT-SANDBOX.md` §5.1 — capability narrowing as the contribution-back primitive (slate 5)
- `docs/CONTEXT-AWARENESS.md` §5 — composition with handoff envelope (slate 3)
- `docs/GATEWAY-CONTRACT.md` — the existing wire contract this doc extends the framing of
- `packages/mcp-tool-provider/` — existing MCP client (slate 2 makes us ALSO an MCP server)
- `packages/operator/src/cap-issuer.ts`, `packages/agent-pod/src/cap-consumer.ts` — capability primitive that slate 5 RFC-extracts
- `packages/blackboard/`, `packages/agent-pod/src/cas-backend.ts`, `packages/operator/src/workspace-controller.ts` — the three existing persistence primitives the handoff envelope (slate 3) references
