# A2A v1.0 wire-conformance implementation plan

**Date:** 2026-05-07
**Status:** Design-research, pre-code. The deliverable from W4-Strategy-A2A.
**Owner / scope:** substrate-level. Slate 1 (`v0.2.3-a2a-wire`) per [`PROTOCOLS.md`](./PROTOCOLS.md) §7.
**License:** MIT
**Reading order before this doc:** [`PROTOCOLS.md`](./PROTOCOLS.md) (the slate this fills in), [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.7 (the Event primitive being mapped), [`evidence/audit-rev2/R2.md`](../evidence/audit-rev2/R2.md) §3 (governance + urgency), [`AUDIT-2026-05-06-PUNCHLIST.md`](./AUDIT-2026-05-06-PUNCHLIST.md) H4 (the line-item this plan retires).

> This doc is design-research only. Nothing lands in code from here. The output of this plan is a slate spec — `v0.2.3-a2a-wire` — that the next workstream picks up against. The single test for this plan: *can a contributor open it cold and know what to build, what NOT to build, and which questions still need user input before code starts?*

---

## 1. Why this plan exists

R2 (`evidence/audit-rev2/R2.md` §3) verified A2A v1.0's governance + production posture as of 2026-05-06:

- **A2A v1.0 GA, March 12 2026.** Linux Foundation under the [Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) (formed Dec 9 2025). Sequence: v0.3 → v1.0 (no v1.1 / v1.2 has shipped; the prior R2's `v1.2` reference was a transcription error and was corrected in commit `167e056`). ([announcement](https://a2a-protocol.org/latest/announcing-1.0/))
- **150+ organizations in production**, anniversary count from the LF April 9 2026 release. ([source](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations))
- **Cloud-native uptake:** AgentCore Runtime native A2A since November 2025 (port 9000, JSON-RPC, agent-card discovery, SigV4 + OAuth2 — [docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html)); Vertex Agent Runtime native via ADK; Foundry Agent Service A2A in preview via Toolbox MCP.
- **Framework uptake:** Google ADK, LangGraph, CrewAI, LlamaIndex Agents, Semantic Kernel, AutoGen all ship native A2A.

R2 §2.2 calls the urgency level *"raised, not steady"* — every day kagent ships without A2A on the wire is another day a real consumer needs a custom adapter to trade tasks with a kagent-hosted agent. This is the highest-leverage interop slate left in the substrate's roadmap.

`AUDIT-2026-05-06-PUNCHLIST.md` H4 is the punchlist line that this plan closes by producing the v0.2.3-a2a-wire slate spec.

---

## 2. A2A v1.0 conformance surface

What the spec actually requires of a "v1.0-conformant" peer. Citations are to [`a2a-protocol.org/latest/specification/`](https://a2a-protocol.org/latest/specification/) section numbers.

### 2.1 Discovery — the AgentCard

A2A's discovery model is **HTTP-based**: a peer publishes a JSON metadata document (the AgentCard) at a well-known URL on its own HTTP origin. ([Spec §8 — Agent Discovery: The Agent Card](https://a2a-protocol.org/latest/specification/#section-8))

- The card is normatively defined in [`spec/a2a.proto`](https://github.com/a2aproject/A2A) at `AgentCard`. ([Spec §4.4.1](https://a2a-protocol.org/latest/specification/))
- Required-ish fields surfaced in spec text: `id`, `name`, `provider`, `capabilities`, `securitySchemes`, `security`, `skills`. ([Spec §8](https://a2a-protocol.org/latest/specification/#section-8))
- v1.0 introduces **signed AgentCards** for cryptographic verification of identity + metadata. ([Announcing 1.0](https://a2a-protocol.org/latest/announcing-1.0/))
- v1.0 supports advertising **dual v0.3 + v1.0 capability** in one card so clients migrate progressively. ([Announcing 1.0](https://a2a-protocol.org/latest/announcing-1.0/))
- Well-known URI: per [Spec §14.3 — Well-Known URI Registration](https://a2a-protocol.org/latest/specification/#section-14). The exact literal path (e.g. `/.well-known/agent-card.json` vs `/.well-known/a2a`) is one of the open questions in §6 below — the spec section is published but the content didn't render cleanly via WebFetch when this plan was drafted; the slate's first task is to read [`spec/a2a.proto`](https://github.com/a2aproject/A2A) directly and pin the literal string before any URL-emitting code lands.
- `GetExtendedAgentCard` JSON-RPC method exists for *authenticated* card retrieval — the public well-known URL serves the unauthenticated view; the authenticated method returns the extended view. ([Spec §9 — JSON-RPC Protocol Binding](https://a2a-protocol.org/latest/specification/))

### 2.2 JSON-RPC method surface

[Spec §9 — JSON-RPC Protocol Binding](https://a2a-protocol.org/latest/specification/) defines the wire methods. Conformance levels are not enumerated in the public Announcing-1.0 page — this plan assumes the realistic minimum a peer must implement to be useful is the **task-lifecycle quartet** plus the **discovery method**:

| Method | Purpose | Conformance posture for kagent |
|---|---|---|
| `SendMessage` | Initiate an agent interaction. Synchronous. | **Required** for inbound (others sending kagent a task). |
| `SendStreamingMessage` | Same as `SendMessage` but with real-time event stream over SSE. | **Optional in slate 1.** Kagent's existing model is async pod-spawn; streaming responses are out of scope until a real consumer drives it (per `SUBSTRATE-V1.md` §8). |
| `GetTask` | Retrieve task state by id. | **Required.** Maps directly to existing `GET /api/tasks/:id` workbench-api shape. |
| `ListTasks` | Paginated query. | **Optional in slate 1.** Workbench has its own list endpoint; A2A `ListTasks` is a candidate post-slate. |
| `CancelTask` | Request task cancellation. | **Required.** Maps to existing `POST /api/tasks/:id/cancel`. |
| `SubscribeToTask` | SSE stream for an existing task. | **Optional in slate 1** (paired with `SendStreamingMessage`). |
| `Create/Get/List/DeleteTaskPushNotificationConfig` | Webhook config for async task updates. | **Optional in slate 1.** Out of scope until the in-pod NATS subscribe primitive lands (slate 4). |
| `GetExtendedAgentCard` | Authenticated card retrieval. | **Optional in slate 1.** Kagent serves only the public card on the well-known URL initially. |

### 2.3 Task lifecycle — `TaskState`

[Spec §4.1.3 — `TaskState`](https://a2a-protocol.org/latest/specification/) defines nine states:

| A2A `TaskState` | kagent `AgentTaskPhase` mapping |
|---|---|
| `TASK_STATE_SUBMITTED` | `Pending` |
| `TASK_STATE_WORKING` | `Dispatched` (operator has spawned the Job) |
| `TASK_STATE_COMPLETED` | `Completed` |
| `TASK_STATE_FAILED` | `Failed` |
| `TASK_STATE_CANCELED` | (no native phase; expressed as `Failed` + `reason: 'cancelled'` today) |
| `TASK_STATE_INPUT_REQUIRED` | (no analog; agents either complete or fail — input-required is a paused state kagent does not model) |
| `TASK_STATE_REJECTED` | (no analog; closest is admission rejection which is a `Failed` with `reason: 'admission_rejected'`) |
| `TASK_STATE_AUTH_REQUIRED` | (no analog) |
| `TASK_STATE_UNSPECIFIED` | (omitted in mapping) |

**Implication for slate 1:** the bridge / native-A2A endpoint translates kagent's 4-phase model to A2A's 9-state vocabulary using the table above. The three "no analog" states are surfaced *only on the inbound side* (we admit them into `Pending`/`Failed` projections); kagent does not generate them on the outbound side because the substrate doesn't model paused tasks. This is acceptable conformance-with-narrowing — A2A clients see a strict subset of the state space, never an undefined state.

### 2.4 Authentication

[Spec §4.5 — Security Objects](https://a2a-protocol.org/latest/specification/) defines the supported schemes:

- `APIKeySecurityScheme`
- `HTTPAuthSecurityScheme` (Basic, Bearer)
- `OAuth2SecurityScheme` (Authorization Code, Client Credentials, Device Code)
- `OpenIdConnectSecurityScheme`
- `MutualTlsSecurityScheme`

[Spec §7 — Authentication and Authorization](https://a2a-protocol.org/latest/specification/) requires "servers MUST reject requests with invalid or missing authentication."

**Substrate alignment:**

- kagent's existing wire is **JWT capability bundles** (`SUBSTRATE-V1.md` §3.6) for in-substrate authority + `X-Forwarded-User` / per-Agent OAuth-via-oauth2-proxy for the workbench-api ingress (`AGENT-SELF-SERVICE.md` §3.5).
- The capability JWT is *not* an A2A-compatible auth scheme in v1.0 — A2A's `OAuth2SecurityScheme` is the closest match because both are bearer-JWT-shaped, but the issuer model differs (kagent caps are operator-CA-signed and per-task; A2A OAuth2 expects an external IdP).
- The slate-1 conformance posture: kagent advertises **`HTTPAuthSecurityScheme(Bearer)`** in its AgentCard. The bearer is one of:
  - the workbench-api's existing API key (mintable via `POST /admin/keys`), OR
  - a new A2A-scoped credential that maps internally to a kagent capability bundle.
- OAuth2 is deferred to slate 1.1 (post-v0.2.3) once a real external A2A peer drives the requirement.

### 2.5 Transport

[Spec §11 — HTTP+JSON/REST Protocol Binding](https://a2a-protocol.org/latest/specification/):

- HTTP: `POST` for messages/creation, `GET` for retrieval, `DELETE` for removal.
- Content-Type: `application/json` (and the registered MIME `application/a2a+json` per [Spec §14.1.1](https://a2a-protocol.org/latest/specification/)).
- Status codes: standard semantics (401, 403, 404, 400, 500).
- Headers: `A2A-Version` mandatory ([Spec §3.6](https://a2a-protocol.org/latest/specification/)); `A2A-Extensions` optional.
- Streaming: HTTP SSE over the REST binding ([Spec §11.7](https://a2a-protocol.org/latest/specification/)) — events are `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` wrapped in a `StreamResponse`.

**Implication for slate 1:** A2A is HTTP-shaped, not NATS-shaped. The **agent-pod has no HTTP server today** — the pod is a one-shot Job whose only outbound contract is the K8s status patch + CloudEvents on NATS. Slate 1 does NOT add an HTTP server in the pod (see §4 architecture decision). The A2A endpoint lives in the workbench-api process, which already speaks HTTP and already projects AgentTask state.

---

## 3. kagent's current Event primitive

[`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.7 defines `Event` as the loose-coordination primitive: pub/sub on `kagent.events.<topic>` (NATS JetStream) plus the per-task-tree blackboard (NATS KV). The shape is **CloudEvents v1.0 over NATS**, not A2A. Today's surface:

- `Agent.spec.publishes[]` / `Agent.spec.subscribes[]` declare topics. Validated by `@kagent/events:validateTopic` (reverse-DNS lowercase, no NATS wildcards). Source: [`packages/operator/src/crds/types.ts`](../packages/operator/src/crds/types.ts) `EventPublishDecl` / `EventSubscribeDecl`.
- Capability claims `claims.publish` / `claims.subscribe` are glob-pattern lists that gate which topics an Agent's tasks may emit / receive (`SUBSTRATE-V1.md` §3.6, [`packages/agent-pod/src/builtin-tools-publish.ts`](../packages/agent-pod/src/builtin-tools-publish.ts) lines 132-160).
- The in-pod `publish_event` tool wraps `@kagent/events:EventPublisher.publish`. CloudEvents envelope is constructed by the publisher; size cap 64 KiB JSON-encoded; topic must be in `Agent.spec.publishes[]` AND `claims.publish` (defense-in-depth — see file-level JSDoc in `builtin-tools-publish.ts`).
- The operator's events dispatcher provisions a NATS pull-consumer per `Agent.spec.subscribes[].topic`; on delivery it mints an AgentTask with the event's `data` field bound either to `payload` or to a typed `inputs[trigger.inputBinding]` entry.

**Key mismatch with A2A:**

| Axis | kagent today | A2A v1.0 |
|---|---|---|
| Wire | NATS JetStream subjects | HTTP/JSON-RPC + SSE |
| Envelope | CloudEvents v1.0 | A2A's `Message` / `Task` / `Event` shapes |
| Discovery | K8s API (LIST agents) + NATS subject ACL | HTTP GET `/.well-known/<path>` agent card |
| Task identity | K8s UID (`metadata.uid`) | A2A `taskId` (UUID) |
| State | 4-phase `AgentTaskPhase` | 9-state `TaskState` |
| Auth | JWT capability bundle (operator-CA signed) | one of 5 security schemes; bearer or OAuth2 most common |
| Push notifications | NATS subject (in-pod subscribe deferred to slate 4) | webhook config via JSON-RPC methods |

The mismatch is **architectural**, not cosmetic. A2A is request-response over HTTP with optional SSE; kagent's Event primitive is fire-and-forget pub/sub over NATS. The two compose, but neither is a drop-in replacement for the other.

---

## 4. Architecture decision — bridge vs native vs hybrid

Three viable shapes; the trade-offs:

### 4.1 Option A — Bridge / adapter pod

A new sidecar process (or Deployment), **`kagent-a2a-bridge`**, exposes A2A's HTTP/JSON-RPC surface and translates inbound calls to kagent's existing primitives:

```
External A2A peer ──HTTP/JSON-RPC──> kagent-a2a-bridge ──> workbench-api ──> AgentTask CR
                                          │
                                          └──NATS subscribe──> agent-pod CloudEvents
                                                                   │
                                          <──HTTP SSE projection───┘
```

- **Pros:** zero touch to the agent-pod, the operator, or the Event primitive. Ships incrementally; can run alongside the existing CloudEvents path indefinitely. Fail-closed: bridge down = no A2A wire, but kagent keeps working.
- **Cons:** extra hop (latency + one more crash domain). Two protocols on the wire that mean the same thing (CloudEvents + A2A `Event`); maintenance cost on every A2A spec bump.

### 4.2 Option B — Native A2A on the Event primitive

`Agent.spec.publishes` / `subscribes` topics speak A2A on the wire directly. The CloudEvents envelope is replaced (or augmented) by an A2A-shaped envelope; the NATS subjects become the transport (substrate) underneath the A2A semantic layer.

- **Pros:** single protocol, clean architecture, the Event primitive *is* the A2A surface.
- **Cons:** A2A is HTTP-shaped — its `SendMessage` / `SubscribeToTask` model assumes a request-response pattern that NATS pub/sub structurally doesn't fit. Forcing A2A's HTTP semantics over NATS subjects either loses A2A's idioms (no SSE, no synchronous JSON-RPC `result` field) or recreates HTTP-over-NATS (which is a separate substrate decision the audit hasn't taken).
- **Cons (back-compat):** every existing CloudEvents consumer (audit warehouse, blackboard, event dispatcher) needs co-evolution. Big surface, big risk.

### 4.3 Option C — Hybrid (bridge default, native optional)

Bridge ships first as the primary path. The native Event-primitive-A2A path is a **future** decision behind a feature flag, only entered if a real consumer demands it.

- **Pros:** ships fastest. Doesn't foreclose the native path. The bridge is small enough to throw away if option B becomes the right choice later.
- **Cons:** two paths to maintain *if* the native path is ever turned on.

### 4.4 Option D — In-pod A2A server (transparent-proxy / AgentCore pattern)

The agent-pod itself runs an A2A JSON-RPC server on a configurable port (default 9000). The operator's CRD reconciler emits a Service+Ingress for each Agent CR with `spec.exposeViaA2A: true`. The Agent Card is generated by the operator and served by the agent-pod's HTTP server. This matches the dominant production pattern verified across hosted vendors (per `evidence/audit-rev3/R2.md` §2.1):

- **AWS Bedrock AgentCore Runtime** is "a transparent proxy layer" — A2A JSON-RPC payloads pass through directly to the agent container on port 9000; the AgentCard at `/.well-known/agent-card.json` is served by the container ([AgentCore A2A protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html)).
- **Vertex Agent Runtime / ADK** — the agent process speaks HTTP+JSON-RPC directly via `ClientFactory(supported_transports=TransportProtocol.http_json)`; SSE for streaming ([Vertex A2A docs](https://docs.cloud.google.com/agent-builder/agent-engine/use/a2a)).
- **Azure Foundry Agent Service** — A2A in preview via the same in-container pattern.

**Pros:**

- **"Speaks A2A natively"** — the same single-line claim AgentCore / Vertex / Azure use. The bridge architecture (Option A) cannot make this claim because A2A traffic lands in a separate process, not the agent's own container.
- **No extra hop** — direct HTTP to the agent process; lower latency; one fewer crash domain.
- **Single protocol on the wire** — A2A end-to-end; no CloudEvents↔A2A transcode for `SubscribeToTask`.
- **No bridge maintenance** — A2A spec bumps land in the agent-pod's HTTP layer, not in a translation shim.
- **A2A `X-A2A-Extensions` headers pass through** — the bridge is forced to either drop them or pass-through verbatim (which defeats the bridge); native-pod-server preserves full v1.0 conformance on the inbound side.
- **`SendStreamingMessage` is straightforward** — agent-pod streams tokens natively; no CloudEvents↔SSE dual-translation hop.
- **Outbound A2A is symmetric** — the same in-pod HTTP layer can serve as both server (inbound) and client (outbound calls to external A2A peers).
- **Survives operator/bridge restart** — pod stays callable while alive.

**Cons:**

- **Requires HTTP server in agent-pod** — not currently present. The agent-pod is a one-shot Job whose only outbound contract is K8s status patch + CloudEvents on NATS; adding inbound HTTP changes the pod design.
- **Complicates pod boot path** — pod must accept inbound HTTP, advertise readiness, handle graceful drain on Job termination.
- **Ties A2A versioning to agent-pod release cadence** — a v1.1 A2A spec bump requires re-rolling the agent-pod image, not a bridge Deployment.
- **Memory cost** — adds ~30-50MB Bun/Node baseline for the HTTP server per pod (vs $0 with bridge).
- **K8s primitive multiplication** — Service + Ingress per Agent (or per AgentTask), unless the operator can multiplex onto one shared Ingress with path-based routing.
- **Substrate orthogonality erosion** — adds an HTTP-shaped concern to the agent-pod. Per `SUBSTRATE-V1.md` §5 this is a real cost; the mitigation is that the new HTTP listener is independent of the Event primitive (which stays CloudEvents-on-NATS).

The pros/cons matrix versus the bridge:

| Axis | Bridge (Option A) | Native (Option D) |
|---|---|---|
| **A2A extensions support (`X-A2A-Extensions`)** | ❌ dropped | ✅ pass through to agent |
| **`SendStreamingMessage`** | ❌ slate 1.5+ (dual-translation) | ✅ agent streams natively |
| **`SubscribeToTask`** | ⚠ via NATS synthesized subject + transcode | ⚠ still needs subscription mechanism but stays in-pod |
| **Outbound A2A** | ❌ separate slate, separate package | ✅ same HTTP server can serve as both client + server |
| **Marketing line** | "Has an A2A bridge" | "Speaks A2A natively, like AgentCore / Vertex / Azure" |
| **Agent-pod runtime cost** | $0 (pod is unchanged) | +memory for HTTP server (~30-50MB Bun/Node baseline) |
| **Agent-pod is no longer one-shot Job** | unchanged | **changed** — must accept inbound HTTP, pivots design |
| **Survives operator/bridge restart** | ❌ bridge down = no A2A | ✅ pod stays callable while alive |
| **K8s primitives needed** | Deployment + Service + Ingress for one bridge | Service + Ingress per Agent (or per AgentTask) — multiplies |
| **Substrate orthogonality** | ✅ NATS untouched | ⚠ adds HTTP-shaped concern to agent-pod |

### 4.5 Recommendation — **Prefer Option D (native), with Option A as a staged fallback**

Updated per `evidence/audit-rev3/R2.md` §2.5. The substrate-shape principle in `SUBSTRATE-V1.md` §5 is *"Primitives are orthogonal."* The original §4.4 reading conflated two separable concerns: **"don't pollute Event primitive with A2A"** (Option B's failure mode — correctly rejected) and **"don't put HTTP in the agent-pod"** (Option D's cost — separable from Option B's failure). Option D pollutes neither: the Event primitive stays CloudEvents-on-NATS; the agent-pod gains a separate HTTP listener that has nothing to do with the Event primitive.

Per AgentCore + Vertex/ADK precedent, "speaks A2A natively" is the dominant production pattern. The bridge architecture (Option A) makes kagent strictly inferior on the table-stakes A2A axis: an enterprise architect comparing "Vertex agents speak A2A" vs "kagent has a bridge that translates A2A to internal CRDs" reads the latter as a less impressive line.

**Recommended path — staged migration A → D:**

1. **Spike Option D in a 1-2-day timebox** before slate-1 code starts. Stand up a minimal HTTP server in `packages/agent-pod/src/a2a-server.ts` that serves the AgentCard and answers `SendMessage` / `GetTask` / `CancelTask`. Determine actual cost (memory footprint, lifecycle complexity, K8s primitive multiplication).
2. **If the spike's cost is acceptable** (memory < 50MB, one shared Ingress with path-based routing per Agent, lifecycle complexity manageable), make Option D the slate-1 architecture.
3. **If the spike's cost is high**, ship Option A first as a learning vehicle (it's incrementally shippable and reuses workbench-api primitives), then migrate to Option D once the bridge surfaces what's needed. Add to the slate-1 plan §10 a **"compat-as-feature limitation"** disclaimer: "kagent's A2A surface is bridge-mediated; v1.0 features that depend on header pass-through (`X-A2A-Extensions`, custom security schemes beyond Bearer, in-message metadata flowing to the agent) are not supported in slate 1."

The translation surface in §4.6 below describes Option A's shape (the bridge); the §5 implementation slate currently codifies Option A. **Both should be re-evaluated post-spike**; if the spike clears, Option D's slate-1 shape is small (in-pod HTTP server + per-Agent Service/Ingress, no separate Deployment/Helm chart) and the bulk of `packages/a2a-bridge/` reduces to `packages/agent-pod/src/a2a-server.ts` + protocol code.

### 4.6 Option A's translation surface (bridge details, retained for reference)

The substrate-shape principle in `SUBSTRATE-V1.md` §5 is *"Primitives are orthogonal."* A2A is HTTP-shaped; kagent's Event primitive is NATS-shaped. Forcing A2A onto NATS subjects (Option B) breaks orthogonality without solving the problem A2A actually solves (which is HTTP/JSON-RPC interop with 150+ HTTP-shaped peers). If Option D's spike rules it out, the bridge is the right composition.

Concretely:

- A new package `@kagent/a2a-bridge` ships as a small Bun (or Node) HTTP server. Runs as a separate Deployment in the operator's namespace.
- It speaks the A2A v1.0 JSON-RPC surface for *inbound* calls. It does NOT proxy *outbound* — kagent agents publishing TO external A2A peers is slate-1.5 (not in this plan; see §7).
- Translation surface is small:
  - `SendMessage` → workbench-api `POST /api/tasks` (existing path, scoped by an A2A-credential-mapped capability key).
  - `GetTask` → workbench-api `GET /api/tasks/:id`.
  - `CancelTask` → workbench-api `POST /api/tasks/:id/cancel`.
  - AgentCard well-known URL → operator-derived from Agent CRs (the bridge GETs the K8s API at startup + watches; one card per Agent CR with `spec.exposeViaA2A: true`).

The bridge is **inbound-only in slate 1**. Outbound (a kagent agent INVOKING a remote A2A peer) requires a new in-pod tool (`a2a_send_message`) and is deferred. The Event primitive's NATS subjects continue to speak CloudEvents; A2A is the HTTP surface bolted alongside, not replacing.

**Subject-mapping table (the title of this plan):**

| kagent subject | A2A surface | Bridge translation |
|---|---|---|
| (none — A2A is request-response) | `SendMessage` (RPC) | bridge POSTs `workbench-api/api/tasks` with mapped Agent + payload; awaits `Pending` → `Dispatched` → terminal phase; returns `Message` shape |
| (none) | `GetTask` (RPC) | bridge GETs `workbench-api/api/tasks/:id`; projects `AgentTaskPhase` → `TaskState` |
| (none) | `CancelTask` (RPC) | bridge POSTs `workbench-api/api/tasks/:id/cancel` |
| `kagent.events.<agent>.completion` (synthesized; new) | `SubscribeToTask` (SSE) | bridge subscribes to a synthesized NATS subject the operator emits on AgentTask phase transitions; transcodes CloudEvents → `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` SSE frames |
| K8s API LIST agents | `/.well-known/<path>` (HTTP) | bridge re-renders Agent CRs to AgentCard JSON on each request; one card per Agent with `spec.exposeViaA2A: true` |
| K8s API LIST agents | `GetExtendedAgentCard` (RPC) | (slate 1.1) authenticated card; folds in `capabilityClaims` shape that the public card omits |

The synthesized `kagent.events.<agent>.completion` subject **is the one new NATS shape this slate adds**. It is operator-emitted on every AgentTask phase transition, scoped to the parent Agent's name, and is the primary internal coupling between the substrate's NATS bus and the bridge's HTTP/SSE surface. CloudEvents envelope; substrate-private (not on the cap claim list authored by Agent specs).

---

## 5. Implementation slate — `v0.2.3-a2a-wire`

### 5.1 What lands

Files / packages, ordered by dependency:

| # | Path | Purpose | Approx. LOC |
|---|---|---|---|
| 1 | `packages/a2a-bridge/src/types.ts` | A2A v1.0 type surface — zod schemas for `AgentCard`, `Message`, `Task`, `TaskState`, the JSON-RPC method requests / responses, the SSE event frames. Generated from `spec/a2a.proto` where possible; hand-written for the subset slate-1 implements. | ~600 |
| 2 | `packages/a2a-bridge/src/agent-card.ts` | Render an `Agent` CR (per `crds/types.ts:Agent`) into a v1.0 `AgentCard` JSON. Map `spec.tools` → `skills`; `spec.publishes` → declared capability bullets; `spec.capabilityClaims` is omitted from the public card (extended-card-only). | ~250 |
| 3 | `packages/a2a-bridge/src/jsonrpc.ts` | Minimal JSON-RPC 2.0 framing + dispatcher. The five slate-1 methods (`SendMessage`, `GetTask`, `CancelTask`, the well-known card serve, and `SubscribeToTask` SSE handler). | ~400 |
| 4 | `packages/a2a-bridge/src/state-mapper.ts` | The `AgentTaskPhase` ↔ `TaskState` translator (table in §2.3). Pure, unit-tested. | ~120 |
| 5 | `packages/a2a-bridge/src/sse.ts` | SSE response writer. CloudEvents → `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` transcode. | ~200 |
| 6 | `packages/a2a-bridge/src/auth.ts` | Bearer-token validation; maps the inbound bearer to a workbench-api API key (existing infra). Reuses `@kagent/llm-gateway`'s API-key db pattern via the workbench's mint endpoint. | ~150 |
| 7 | `packages/a2a-bridge/src/server.ts` | HTTP server (Bun or Node). Routes: `GET /.well-known/<path>`, `POST /v1/jsonrpc`, `GET /v1/tasks/:id/stream` (SSE). Listens on a configurable port (default 8080). | ~300 |
| 8 | `packages/a2a-bridge/src/main.ts` | Process entrypoint. K8s informer for Agent CRs; reload AgentCard cache on change. Health probe `/livez`, `/readyz`. | ~200 |
| 9 | `packages/a2a-bridge/Dockerfile` | Per-Dockerfile-comment lessons in `CLAUDE.md`: Node 22 + tsx initially; Bun once TLS parity lands. | ~30 |
| 10 | `packages/operator/src/crds/types.ts` | New `Agent.spec.exposeViaA2A?: boolean` (default false) — only Agents with this true appear in the bridge's served card list. **Additive, no CRD bump beyond minor.** | ~15 |
| 11 | `packages/operator/manifests/crds/agent.yaml` | Schema mirror for `exposeViaA2A`. | ~10 |
| 12 | `packages/operator/charts/kagent-bridge/` | New Helm chart for the bridge Deployment + Service + (optional) Ingress + ServiceAccount + Role binding (read-only on Agent CRs). | ~300 |
| 13 | `packages/a2a-bridge/test/*.test.ts` | Unit + smoke tests. ≥80% coverage on `agent-card.ts` + `state-mapper.ts`; integration test for `SendMessage` round-trip via mocked workbench-api. | ~800 |
| 14 | `docs/A2A-BRIDGE.md` | Per-bridge consumer doc. AgentCard semantics, well-known URL, auth, examples (`curl`-able SendMessage + GetTask). | ~400 |
| 15 | `docs/PROTOCOLS.md` (edit) | Update slate-1 cross-link to point at this plan + the `A2A-BRIDGE.md`; check the v0.2.3 box on completion. | ~10 |
| 16 | `docs/ROADMAP.md` (edit) | Add `v0.2.3-a2a-wire` row. | ~10 |

**Total estimate: ~3,800 LOC** (3,000 implementation + 800 test). Slate is single-PR-shippable per `PROTOCOLS.md` §7 framing.

### 5.2 What does NOT land

- **Outbound A2A** (kagent agent calling external A2A peer). Requires in-pod tool. Defer to slate 1.5 / `v0.2.3.1-a2a-outbound`.
- **`SendStreamingMessage`.** SSE is in for `SubscribeToTask` because the existing operator NATS path can drive it; `SendStreamingMessage` requires the agent-pod to stream tokens, which it does not today.
- **Webhook push notifications** (`Create/Get/.../TaskPushNotificationConfig`). Out of scope; relies on slate 4 in-pod NATS subscribe to be useful.
- **Native Event-primitive A2A path.** Per §4.4 — orthogonality argument; revisit if a real consumer demands it.
- **`GetExtendedAgentCard`** with `capabilityClaims` projection. Slate 1.1 once auth shape is settled.
- **OAuth2 / OIDC / mTLS auth schemes.** Bearer + the existing API-key model is sufficient for slate 1.
- **A2A registry / directory hosting.** Per `PROTOCOLS.md` §10 — "kagent does NOT become a registry/discovery service." Each kagent install serves its own well-known URL only.

### 5.3 Slate ordering vs the rest of `PROTOCOLS.md` §7

- Slate 1 (this slate, `v0.2.3-a2a-wire`) — A2A inbound bridge.
- Slate 2 (`v0.2.4-mcp-server-out`) — independent; can land in parallel with slate 1 since it's HTTP-shaped on the same workbench-api.
- Slate 3 (`v0.2.5-handoff`) — depends on slate 1 (handoff envelope is A2A-task-lifecycle-shaped where possible).
- Slate 4 (`v0.2.6-in-pod-nats`) — unblocks `TaskPushNotificationConfig` in slate-1.5.
- Slate 5 (`v0.2.7-cap-rfc`) — independent; offers the cap primitive upstream.

### 5.4 Pre-slate-1 dependencies (already met)

- **B6 / B7 closed** (Wave 0): workbench-api auth is fail-closed by chart preflight; bundled-Postgres secret hygiene fixed. The bridge reuses the workbench's auth model.
- **Capability-narrowing RFC drafted** (W4-upstream): the upstream contribution play is on slate 5; doesn't gate slate 1.
- **PROTOCOLS.md A2A version corrected** to v1.0 (commit `167e056`): done.

---

## 6. Open questions (require user input before code starts)

These are blocking for the slate-1 PR. Listed in priority order; each has a recommended default for if the user wants to proceed without explicit input.

1. **AgentCard well-known URL — literal path?** Spec §14.3 specifies a well-known URI but the literal string didn't render via WebFetch for this plan. Candidates: `/.well-known/agent-card.json`, `/.well-known/a2a`, `/.well-known/agent.json`. **Required action:** read [`spec/a2a.proto`](https://github.com/a2aproject/A2A) directly + cross-reference an AgentCore / Vertex live-deployed kagent peer. **Default if no input:** start with `/.well-known/agent-card.json`; pin to whatever `spec/a2a.proto` actually declares.

2. **Auth: A2A bearer credential mint shape — reuse workbench API keys, or new A2A-scoped credential type?**
   - Option 1: Reuse `POST /admin/keys` (existing workbench infra). Bearer is a workbench API key with a `scope: 'a2a'` claim.
   - Option 2: New credential type `A2ACredential` with its own CRD + mint surface.
   - **Default if no input:** Option 1 (reuse). New CRDs are heavy; the existing key infra has revocation, rotation, and `last_used_at` (once H18 fix lands).

3. **AgentCard publication — opt-in (`exposeViaA2A: true`) or opt-out (default visible)?**
   - **Default if no input:** opt-in. Default-deny matches the rest of the substrate (`SUBSTRATE-V1.md` §3.6 cap claims, `Agent.spec.egress` baseline, `Agent.spec.publishes[]`). Operator stamps a Helm-side warning if opt-in count is zero ("A2A bridge running with zero exposed Agents").

4. **AgentCard signing — slate 1 or slate 1.1?** v1.0 introduces signed AgentCards as a notable feature. Signing requires a CA + key management story.
   - **Default if no input:** **slate 1.1.** Slate 1 ships unsigned cards (still spec-conformant; signing is "introduces" not "requires"). Reuse the operator CA (`packages/operator/src/cap-ca.ts`) when 1.1 lands.

5. **Bridge crash-domain — Deployment per cluster or per Agent?**
   - **Default if no input:** one Deployment per cluster (single instance; HA via 2-replica + leader election deferred). Per-Agent-pod isolation would force a new HTTP server per pod, which contradicts §4.4's decision.

6. **Synthesized `kagent.events.<agent>.completion` subject — declared in capability claims, or substrate-private?**
   - **Default if no input:** substrate-private (analogous to the audit stream — emitted by operator, consumed by bridge, not surfaced to Agent specs). No new claim needed.

7. **Back-compat with v0.3?** v1.0 supports advertising dual support. Worth advertising both?
   - **Default if no input:** **v1.0 only.** v0.3 implementations are migrating; the dual-advertise is for clients on the migration path, not the server. Re-evaluate if a real v0.3 client surfaces.

---

## 7. Out of scope for this plan

- The actual implementation of `@kagent/a2a-bridge` (separate workstream, kicked off by the slate-1 PR).
- The outbound A2A path (slate 1.5).
- The native Event-primitive-speaks-A2A architectural alternative (per §4.4 only revisited if option A proves insufficient under real consumer load).
- Performance / scale benchmarking of the bridge — the substrate doesn't have a benchmarks track yet (R2 §6 recommendation #3); when it does, bridge load profile becomes a row in that track.
- Multi-tenant A2A scoping (one bridge serving N tenants with per-tenant cards). Tenancy is a Wave-4 concern (`SUBSTRATE-V1.md` §6); A2A bridge tenant-isolation rides on top of the Tenant primitive when it lands.

---

## 8. Cross-references

- [`PROTOCOLS.md`](./PROTOCOLS.md) §5.1 (A2A status) and §7 Slate 1 (the slate this plan fills in)
- [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.7 (Event primitive being mapped), §5 (orthogonality rule that drove the bridge decision)
- [`evidence/audit-rev2/R2.md`](../evidence/audit-rev2/R2.md) §3 (governance + production state of A2A v1.0)
- [`AUDIT-2026-05-06-PUNCHLIST.md`](./AUDIT-2026-05-06-PUNCHLIST.md) H4 (the punchlist line this plan retires)
- [`packages/operator/src/crds/types.ts`](../packages/operator/src/crds/types.ts) `Agent`, `EventPublishDecl`, `EventSubscribeDecl` (the existing primitives the bridge composes against)
- [`packages/agent-pod/src/builtin-tools-publish.ts`](../packages/agent-pod/src/builtin-tools-publish.ts) (the in-pod publish path that stays unchanged)
- [`docs/AGENT-SELF-SERVICE.md`](./AGENT-SELF-SERVICE.md) §3.5 (the workbench-api auth model the bridge reuses)
- [A2A v1.0 spec — a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)
- [A2A v1.0 announcement — a2a-protocol.org/latest/announcing-1.0/](https://a2a-protocol.org/latest/announcing-1.0/)
- [a2aproject/A2A on GitHub](https://github.com/a2aproject/A2A) (`spec/a2a.proto` is the normative schema)
- [Linux Foundation — Agentic AI Foundation formation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Linux Foundation — A2A 150+ orgs anniversary release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [AgentCore A2A docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html)
