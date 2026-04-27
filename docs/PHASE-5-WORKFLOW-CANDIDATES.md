# Phase 5 — workflow candidate selection

**Date:** 2026-04-26
**Status:** Recommendation; pre-implementation
**Decides:** which single workflow Phase 5 ports to the new substrate to satisfy the falsifiable comparison rig defined in [`ROADMAP.md`](./ROADMAP.md#comparison-rig--the-falsifiable-test) and [`WHY.md`](./WHY.md#6-the-fail-state-we-are-honest-about).

## 1. Context — what Phase 5 must prove, not invent

Phase 5 is the substrate's first contact with a real workload. The job is **prove the v0.1 primitives carry one workload end-to-end**, not enumerate workloads. `kagent` is a substrate, not a workflow framework — see [`CLAUDE.md`](../CLAUDE.md#what-this-repo-does-not-do): no DAG engine, no Swarm engine, no Kubernetes-management agent, no LLM gateway. The picked workload must exercise the v0.1 primitives that already exist — `Agent`, `AgentTask`, NATS A2A, agent-pod runtime, OTel — without forcing a new substrate primitive into v0.1 scope.

The five candidate-substrate primitives were enumerated in the question. v0.1 has shipped exactly two of them as load-bearing: **`AgentTask` (a one-shot task object)** and a **NATS dispatch envelope** (subjects + payload contract). "Task Graph" is two `AgentTask`s with `parentTaskId` set. "Tool Broker" is the `tools[]` field on the Agent CRD plus the in-pod `ToolProvider` abstraction. "Agent Templates" is just the `Agent` CRD itself. **"Replay/Eval" does not exist in v0.1 and will not exist in v0.1.** Any candidate that requires Replay/Eval as a precondition is already out of bounds.

## 2. Scoring matrix

Scale: 1 = poor / risky / slow, 5 = strong / safe / fast.

| Criterion | A. Research + browser + verifier | B. Software patch + reviewer | C. Ops alert + GitOps patch |
|---|---|---|---|
| 1. Primitives meaningfully exercised (of 5) | 4: Task Graph, Artifacts, Tool Broker, Agent Templates | 4: Task Graph, Artifacts, Tool Broker, Agent Templates | 4: Task Graph, Artifacts, Tool Broker, Agent Templates |
| 2. Has a real consumer already (`homelab-orchestrator`) | **5** — researcher + 5-topic digest IS the comparison-rig baseline | 1 — no consumer; would invent | 2 — `new_localai` runs but no agent currently triages |
| 3. Security blast radius (higher = safer) | **4** — read-only HTTP fetch + RSS parse; verifier reads same URLs | 1 — repo write, code-exec, test-exec — RCE-shaped | 2 — kubectl read-only is OK, but writing manifest patches into a GitOps repo crosses into cluster-mutation |
| 4. Comparison-rig story (does the rig already exist?) | **5** — `homelab-orchestrator/topics.yaml` + JSONL traces ARE the baseline; one-week run ⇒ direct cost / completion / latency / F1+F2+F3 deltas | 2 — must invent baseline (which patches? which repo? which reviewer?) | 2 — must invent baseline alert set + ground-truth fix set |
| 5. Time-to-first-useful-output | **4** — researcher already exists in TS; lift `topics.yaml` + tools (`fetch_rss`, `fetch_url`, `extract_text`); add summarizer Agent CRD | 2 — sandboxed code-exec tool not in v0.1; would force scope expansion | 2 — Prom + GitHub-API tooling not in v0.1; would force scope expansion |
| **Total (sum)** | **22** | **10** | **12** |

## 3. Recommendation — Candidate A (research + summarizer A2A delegation)

**Pick Candidate A.** It is the only candidate that aligns with the comparison rig already promised by the project, and it is the only candidate that does not force the substrate to grow a new primitive in v0.1. Roadmap Phase 5 already pre-names this workload ("Port researcher agent from `homelab-orchestrator` → produces same daily digest"). The recommendation is to keep that pick AND scope the A2A demo to a researcher → summarizer chain.

Concretely the workload is: a `CronJob` (or one-shot `kubectl apply`) creates one `AgentTask` per topic in `topics.yaml` against the `researcher` Agent. The researcher runs the same fetch_rss / fetch_url / extract_text loop that runs in `homelab-orchestrator` today. When it has a draft digest, it emits a single `delegate_to_capability("summarize", payload)` call. The substrate routes that to a `summarizer` Agent (separate Pod, separate trace, capability-resolved via the `agents-live` KV bucket). The summarizer returns a tightened digest, the researcher writes the final markdown to `AgentTask.status.result.content`. Same input, same output, but two pods, two traces, NATS in the middle.

This exercises four of the five candidate primitives meaningfully — Task Graph (researcher → summarizer), Artifacts (markdown stored in `AgentTask.status`), Tool Broker (HTTP / RSS / extract-text), Agent Templates (two distinct `Agent` CRDs). Replay/Eval does not exist in v0.1 and the workload does not need it.

## 4. Primitives needed from kagent v0.1 (1..5)

1. **`Agent` CRD with `tools[]` field actually wired through to the executor.** This is Phase 4.x follow-up #4. Phase 5 cannot start until this lands.
2. **`AgentTask` with `parentTaskId` set on the delegated task** — already in the v0.1 envelope contract per `packages/operator/src/envelope.test.ts`.
3. **Capability-routed dispatch (`agent.cap.<cap>.task.<id>`)** — the `NatsCapabilityRegistry` reads `agents-live`; agents register their capabilities on heartbeat. The summarizer publishes `summarize` into the bucket; the researcher's `delegate_to_capability` tool resolves through that bucket.
4. **In-pod `delegate_to_capability` tool** — a thin wrapper in `@kagent/agent-loop` that publishes a child `AgentTask`, blocks on a NATS reply subject, returns the result. This is an in-pod library addition, not a CRD change. Belongs in `@kagent/agent-loop`, not the operator.
5. **`AgentTask.status.result.content` write path** — already in v0.1 (the smoke test patches this). Phase 5 just exercises it twice (parent + child) and verifies the parent's status reflects the delegation chain.

Comparison-rig deliverable: run the existing `topics.yaml` on `homelab-orchestrator` and on kagent v0.1 in parallel for one week. Diff completion rate, median cost, median latency, and F1/F2/F3/refusal/vacuity counts (already lifted into `@kagent/agent-loop` per Phase 1). Publish numbers in `docs/V0.1-COMPARISON.md` per the Phase 5 checklist.

## 5. Explicit do-not-build-yet (scope creep that LOOKS related)

These look adjacent to Candidate A but are NOT in Phase 5. Each would either inflate v0.1 substrate primitives or contradict the "substrate, not framework" rule.

- **Source-verifier sub-agent.** Tempting (matches Candidate A's original framing) but it adds a third Agent type, a fan-out pattern (one verifier per source), and an aggregation step. Fan-out is workflow-engine territory. Defer to v0.2 or to a consumer repo.
- **Web-archive snapshot artifact store.** Object storage / PVC-backed artifacts is a substrate primitive that v0.1 does not have. `AgentTask.status.result.content` (string) is the only artifact channel in v0.1. Defer.
- **Browser tool (Playwright / Puppeteer).** RSS + HTTP fetch + readability extract already cover the workload. Adding browser introduces a 600MB image, RCE surface, and headless-Chrome ops. Defer indefinitely; if a consumer needs it, it lives in the consumer's tool set.
- **Replay / eval harness.** Phase 5 reads JSONL traces + Langfuse-recorded runs for the comparison; that is *measurement*, not *replay*. A real replay primitive (re-run a captured task against a different model, diff outputs) is a separate phase.
- **Multi-source verifier templates / per-language patcher templates / per-alert investigators.** "Agent Templates" in v0.1 is the `Agent` CRD with `model` + `systemPrompt` + `tools` + `capabilities`. Generating Agents from a higher-level template is a CRD-of-CRDs pattern that belongs in a consumer or in a v0.3 helper, not in v0.1.
- **Operator-side workflow / DAG controller.** Explicitly disallowed by `CLAUDE.md` "What this repo does NOT do". The researcher → summarizer chain is two `AgentTask`s linked by `parentTaskId`; the operator does NOT learn graph topology.
- **Kata `RuntimeClass: kata` enforcement.** Phase 6 territory. Phase 5 runs on `runc`. If the workload exposes a sandbox gap, log it for Phase 6.
- **Streaming digest output.** Batch only in v0.1, per `DESIGN-V0.1.md` §5.

## 6. First `Agent` + `AgentTask` resources (sketch — for Phase 5 implementation)

These are illustrative shapes, not committed YAML. Real manifests live in the Phase 5 commits.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: researcher
  namespace: kagent-workloads
spec:
  model: workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct
  systemPrompt: |
    (lifted verbatim from homelab-orchestrator/src/researcher.ts RESEARCHER_SYSTEM_PROMPT)
  tools:
    - name: fetch_rss
      provider: in-process            # implementation lives in agent-pod image
    - name: fetch_url
      provider: in-process
    - name: extract_text
      provider: in-process
    - name: delegate_to_capability    # synthetic tool injected by @kagent/agent-loop
      provider: builtin
  capabilities: []                    # researcher does not advertise itself for delegation
  sandboxProfile: default
---
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: summarizer
  namespace: kagent-workloads
spec:
  model: workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct
  systemPrompt: |
    You receive a draft markdown research digest. Tighten it to 200-300 words while
    preserving every source link. Drop filler. Return ONLY the tightened markdown.
  tools: []                           # pure-LLM step, no tools
  capabilities:
    - summarize                       # registers under agent.cap.summarize.*
  sandboxProfile: default
---
apiVersion: kagent.knuteson.io/v1alpha1
kind: AgentTask
metadata:
  name: digest-cloudflare-workers-ai-2026-04-27
  namespace: kagent-workloads
spec:
  targetAgent: researcher
  payload:
    topic:
      slug: cloudflare-workers-ai
      title: Cloudflare Workers AI — what's new
      description: |
        Track Cloudflare's Workers AI platform...
      sources:
        - https://blog.cloudflare.com/tag/workers-ai/rss/
        - https://developers.cloudflare.com/workers-ai/changelog/
        - https://developers.cloudflare.com/agents/changelog/
    today: "2026-04-27"
  timeoutSeconds: 600
```

When the researcher pod calls `delegate_to_capability("summarize", { draft })`, `@kagent/agent-loop` synthesizes a child `AgentTask` with `targetCapability: summarize` and `parentTask: digest-cloudflare-workers-ai-2026-04-27`. The operator resolves it through `agents-live`, dispatches a Pod for the `summarizer` Agent, and the result rides the NATS reply subject back to the researcher's blocking tool call.

That is Phase 5. Anything bigger is the next phase.
