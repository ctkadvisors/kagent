# Audit Punchlist — kagent (REV 3 — 2026-05-07)

Companion to [`AUDIT-2026-05-07.md`](./AUDIT-2026-05-07.md). HEAD `f3f441d`.

**Schema:** severity / category / source / finding / evidence / smallest fix.
**Status legend:** `[NEW]` — first surfaced in rev3. `[OPEN-PARTIAL]` — rev2 fix incomplete. `[STRATEGIC]` — narrative or process work, not a code fix.

---

## BLOCKER

| # | severity | category | source | finding | evidence | recommendation |
|---|---|---|---|---|---|---|
| **R3-B1** | BLOCKER | code | R3 | `[NEW]` `@kagent/agent-loop-vercel-ai` runner terminates after ONE LLM step. `runner.ts:181-193` declares `maxSteps` but never threads it to `streamText`. AI SDK default `stopWhen: stepCountIs(1)` kicks in. All 4 runner tests use `_streamText` stub that fakes multi-step behavior. The W4 reference adapter intended to prove "any framework runs in a pod" does not run a multi-step agent loop. | `packages/agent-loop-vercel-ai/src/runner.ts:181-193`; tests at `runner.test.ts:128-201` use stubs. | Pass `stopWhen: stepCountIs(opts.maxSteps ?? 16)` to `streamText`. ~3 LOC. Add regression test using a real (or higher-fidelity-fake) `streamText` that returns multiple tool-call rounds; assert the runner makes ≥2 LLM calls. |

---

## HIGH

| # | severity | category | source | finding | evidence | recommendation |
|---|---|---|---|---|---|---|
| **C1-NEW-H1** | HIGH | code | C1 | `[NEW]` `safeRestart` `attempts` counter never reset. `reset()` exists in `informer-restart.ts:153-158` but is captured-and-never-called by `watch.ts` or `job-watch.ts`. `maxConsecutiveFailures=12` is actually `maxTotalNonConcurrentErrors`. Twelve transient flaps over operator lifetime → permanent informer wedge → `/healthz` reports 200 for up to 5 minutes while no AgentTask events process. | `packages/operator/src/informer-restart.ts:153-158,181-184`; `grep -rn 'reset()' packages/operator/src/{watch,job-watch}.ts` returns 0 hits. Confidence: 90. | In `watch.ts` and `job-watch.ts`, capture the restarter and call `restarter.reset()` from each `informer.on('add', ...)` handler. ~4 LOC across 2 files. |
| **C3-REV3-H1** | HIGH | code | C3 | `[OPEN-PARTIAL]` B5 fix is partial. `MIN_SAFE_MIN=1` clamp applied to `model-watch.ts:179` and `gateway.ts:147` but NOT to `model-index.ts:147`. `ModelIndex.lookup()` returns unclamped `minSafe`. Router calls `aimd.updateBounds` with that value on every request → overwrites watch-time clamp → original B5 DoS restored for any CR with `spec.minSafe: 0`. | `packages/llm-gateway/src/model-index.ts:147`; `router.ts:148-153`; `aimd.ts:103-105`. Confidence: 92. | Change `model-index.ts:147` from `ep.spec.minSafe ?? 1` to `Math.max(1, ep.spec.minSafe ?? 1)`. Same fix at `admin-routes.ts:183` for display accuracy. ~2 LOC. |
| **R2-H1** | HIGH | strategic | R2 | A2A bridge architecture in `A2A-IMPLEMENTATION-PLAN.md` §4 loses the "speaks A2A natively" qualifier. AgentCore + Vertex/ADK use transparent-proxy pattern (agent container itself runs A2A on port 9000). The bridge approach makes kagent strictly inferior on the table-stakes A2A axis. | `docs/A2A-IMPLEMENTATION-PLAN.md` §4; cross-ref AgentCore A2A docs + Vertex Agent Engine ADK pattern. | Spike Option D (in-pod A2A server) before committing to bridge. Update §4 with bridge + native + hybrid trade-off table; recommend native. |

---

## MEDIUM

| # | severity | category | source | finding | evidence | recommendation |
|---|---|---|---|---|---|---|
| **C1-SIB-1** | MEDIUM | code | C1 | `[NEW]` `fetchAgent` in `supervision-router.ts:498-521` still does direct uncached `customApi.getNamespacedCustomObject` call on every supervision reconcile. Same pre-M2 pattern; M2 fixed `fetchParentTask` and `fetchTaskByUid` but missed this sibling. | `packages/operator/src/supervision-router.ts:498-521`. Confidence: 82. | Add optional `getAgentByName?: (namespace, name) => Agent \| undefined` dep to `SupervisionRouterDeps`, backed by an Agent informer cache. Wire from `main.ts`. |
| **C1-CONFIG** | MEDIUM | code | C1 | Operator config model is inconsistent. `contextSafetyThreshold` / `contextPressureThreshold` / `blackboard.failOpen` use Helm `validateValues` for fail-fast OOR detection. `supervision.maxEscalationDepth` does NOT — bad values silently fall back to default 8. | `packages/operator/charts/kagent-operator/templates/_helpers.tpl:93-134`; `values.yaml:807`. Confidence: 82. | Add `hasKey` + range check to `validateValues` for `maxEscalationDepth`. ~5 LOC of helm template. |
| **R1-WHY-§1.b** | MEDIUM | strategic | R1 | `WHY.md §1.b` claim "no OSS K8s-native agent operator ships caveat-narrowing JWT capabilities" needs explicit "OSS, not enterprise" + "narrowing-on-spawn, not OBO-identity" qualifiers. Solo.io kagent enterprise (commercial) ships controller-minted RS256 JWTs + JWKS endpoint for OBO. Same wire shape; different primitive. | `docs/WHY.md §1.b`; `docs.solo.io/kagent-enterprise/.../security/obo/`. | Update WHY.md §1.b language. Add adjacent-but-not-equivalent paragraph to `RFC-CAPABILITY-NARROWING.md §1.2` covering kagent-enterprise OBO. Drop the "Macaroons are a 2014-era concept" sentence (doesn't add evidence). |
| **R1-CONTEXT-§3** | MEDIUM | strategic | R1 | `CONTEXT-PRESSURE-PRIMITIVE.md` §3 comparison table understates the substrate-thick lane. Microsoft Agent Framework 1.0 ships `CompactionTrigger`/`TokenBudgetComposedStrategy` (experimental). Anthropic `compact-2026-01-12` beta is now operator-tunable. Honest framing: kagent is the only OSS substrate that bets the OPPOSITE way (refuse + flag), not "no one ships anything in this lane." | `docs/CONTEXT-PRESSURE-PRIMITIVE.md §3`; MS Agent Framework docs at `learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction`; Anthropic compaction docs. | Update §3 table to add MAF + Anthropic-now-configurable rows. Reframe the supporting argument from "no one ships" to "every shipped peer chose substrate-thick; kagent intentionally bets the other way." |
| **R2-H3** | MEDIUM | process | R2 | `V0.1-COMPARISON.md` is structurally falsifiable but operationally ~60% runnable. Five missing deliverables: daily-check script, agenttask template, topic 4 manifests, pricing reconciliation, dry-run preconditions probe. User cannot execute the rig as currently written. | `docs/V0.1-COMPARISON.md` (per W4-Strategy-Comparison's own §4 acknowledgement). | Backfill the 5 deliverables before the user attempts to run the rig. ~4-6 hours of focused work. |
| **R2-MOAT** | MEDIUM | strategic | R2 | The "12-month moat" claim for the substrate-thin context-pressure primitive (R2.5 §5.2 Moat 1) is too optimistic. Pressure-tests at 4-7 months. OpenAI/Cloudflare can clone the four-piece composition in 2-3 weeks of SDK work. | `docs/CONTEXT-PRESSURE-PRIMITIVE.md`; rev3 R2.5. | Update marketing language to 4-7 months. The real moat is the substrate-shaped doctrine + the SIG-Apps contribution path. Recommend flipping slate ordering: ship S5 (capability RFC) BEFORE S3 (A2A wire) per R2 §5. |

---

## LOW / NIT

| # | severity | category | source | finding | evidence | recommendation |
|---|---|---|---|---|---|---|
| **C1-NEW-L1** | LOW | doc | C1 | `[NEW]` `supervision-router.ts:311` JSDoc cites `agentPod.supervision.maxEscalationDepth` but actual values.yaml path is `supervision.maxEscalationDepth`. | `packages/operator/src/supervision-router.ts:311` vs. `values.yaml:807`. | Fix JSDoc path. ~1 LOC. |
| **C1-SIB-2** | LOW | code | C1 | `listSiblings` returns `[]` when `listChildrenForParent` is undefined. Production wires it (so not WBD), but tests omitting the dep silently exercise a degenerate sibling-list case. | `packages/operator/src/supervision-router.ts:523-530`. | Either make `listChildrenForParent` required on `SupervisionRouterDeps`, or document the test discipline that all `evaluateStrategy` tests must provide it. |
| **C2R3-LOW-1** | LOW | code | C2 | `[NEW]` H8+H11 interaction: JWKS-fail-at-boot writes Failed status patch via JSON Patch with `test` op on `/status/phase`. If AgentTask was created but operator crashed before patching `Pending`, both `test` ops return 412 → patch silently dropped. Very low probability. | `packages/agent-pod/src/status.ts:184-185`; H11 fix at `cap-consumer.ts:353-398`. Confidence: 80. | Test for `/status` object existence first, OR use RFC 6902 `add` with conditional `path: /status/phase`. The correct fix is operator-side (ensure `status.phase` is always set before dispatching the Job). Low priority. |
| **C2R3-LOW-2** | LOW | code | C2 | `[NEW]` `wrapGenerate` direct `.total` property access without optional chaining at `context-safety-middleware.ts:172`. Non-conformant provider that omits `inputTokens` causes `TypeError`; safety-net cumulative counter doesn't update. | `packages/agent-loop-vercel-ai/src/context-safety-middleware.ts:172`. Confidence: 82. | Replace with `result.usage.inputTokens?.total` and `result.usage.outputTokens?.total`. `recordUsage` already guards `Number.isFinite`. ~2 LOC. |
| **C2R3-INFO-1** | INFO | obs | C2 | `KAGENT_SPEC_SOURCE` annotation diverges from runtime in `'mixed'` partial-mount case. Operator stamps `configmap` annotation; pod runtime computes `mixed`. Monitoring gap, not correctness. | `packages/operator/src/job-spec.ts:936-937` vs `packages/agent-pod/src/env.ts:358-359`. | Document the `mixed` case in CONTEXT-AWARENESS.md or accept as-is (operator can't predict partial mounts). |
| **R3-LOW-1** | LOW | code | R3 | `@kagent/agent-loop-vercel-ai` middleware lacks `estimateTokens` fallback for usage-less providers (Cloudflare Workers AI is a known one). Safety-net silently no-ops. | `packages/agent-loop-vercel-ai/src/context-safety-middleware.ts`. | Add `estimateTokens` fallback when `result.usage.{inputTokens,outputTokens}` is undefined. ~10 LOC. |
| **R3-LOW-2** | LOW | code | R3 | `@kagent/agent-loop-vercel-ai` trace bridge is in-memory array; production OTel/Langfuse observability silently dropped. | `packages/agent-loop-vercel-ai/src/trace-sink-adapter.ts`. | Replace in-memory array with TraceSink delegating to the same OTel/Langfuse path `@kagent/agent-loop` uses. |
| **R3-LOW-3** | LOW | doc | R3 | Cap wrapper does not invoke `loadCapabilityOptional` in `@kagent/agent-loop-vercel-ai` (caller's responsibility per README, but undocumented in adapter API surface). | `packages/agent-loop-vercel-ai/src/capability-tool-wrapper.ts`; README. | Document the caller-responsibility contract more prominently in the package's main TSDoc, or invoke `loadCapabilityOptional` defensively at adapter boot. |
| **R3-LOW-4** | LOW | test | R3 | `runner.test.ts:128-201` detector test admits in plain English it tests the negative shape — title says "tests detector firing"; body asserts the negative. With stubbed `streamText`, middleware cumulative counter stays at 0; detector cannot fire. | `packages/agent-loop-vercel-ai/src/runner.test.ts:128-201`. | Replace stub with a higher-fidelity fake that exercises the cumulative counter. Re-title or split the test honestly. |

---

## STRATEGIC (process work, not code fixes)

| # | category | source | finding | recommendation |
|---|---|---|---|---|
| **S-RE-ORDER** | strategic | R2 | Slate ordering should flip: capability-narrowing RFC (S5) BEFORE A2A wire (S3). Contribution-back is the only path that converts a 4-7-month moat into permanent positioning. | Update `PROTOCOLS.md` slate ordering. Begin S5 RFC issue/PR upstream to `kubernetes-sigs/agent-sandbox` while the SIG-Apps gap is uncontested. |
| **S-V0.1-RIG** | process | R2 | Five concrete deliverables missing for `V0.1-COMPARISON.md` to be runnable. | Backfill before any user-facing rig run. ~4-6 hours of focused work. |
| **S-A2A-OPTION-D** | strategic | R2 | A2A bridge architecture loses the "speaks A2A natively" qualifier. | Update `A2A-IMPLEMENTATION-PLAN.md` §4 with Option D as recommended. |
| **S-MAF-HONEST** | strategic | R1 | Update `CONTEXT-PRESSURE-PRIMITIVE.md` §3 with MAF + Anthropic operator-tunable rows. Reframe supporting argument honestly. | Doc edit. ~30 minutes. |
| **S-OBO-QUALIFY** | strategic | R1 | `WHY.md §1.b` needs "OSS, not enterprise" + "narrowing-on-spawn, not OBO-identity" qualifiers. | Doc edit. ~15 minutes. |

---

## Tally — what would close all rev3 findings

| Action | Severity | Files | LOC |
|---|---|---|---|
| Fix R3-B1 (vercel-ai maxSteps) | BLOCKER | `runner.ts` | ~3 |
| Fix C1-NEW-H1 (safeRestart reset) | HIGH | `watch.ts`, `job-watch.ts` | ~4 |
| Fix C3-REV3-H1 (B5 partial) | HIGH | `model-index.ts`, `admin-routes.ts` | ~2 |
| Fix C1-SIB-1 (fetchAgent uncached) | MEDIUM | `supervision-router.ts`, `main.ts` | ~30 |
| Fix C1-CONFIG (escalation-depth chart guard) | MEDIUM | `_helpers.tpl` | ~5 |
| Fix C2R3-LOW-2 (vercel-ai optional chaining) | LOW | `context-safety-middleware.ts` | ~2 |
| Fix R3-LOW-1 (estimateTokens fallback) | LOW | `context-safety-middleware.ts` | ~10 |
| Fix R3-LOW-2 (trace bridge to OTel sink) | LOW | `trace-sink-adapter.ts` | ~20 |
| Fix C1-NEW-L1 (JSDoc) | LOW | `supervision-router.ts` | ~1 |
| Doc edits (R1, R2 strategic) | STRATEGIC | `WHY.md`, `RFC-*`, `CONTEXT-PRESSURE-*`, `A2A-*` | doc-only |
| V0.1-COMPARISON backfill | PROCESS | `V0.1-COMPARISON.md` + scripts | ~4-6h |

**Code-side total: ~77 LOC across 9 files** to close all NEW BLOCKER + HIGH + MEDIUM + LOW findings.

The rev3 punchlist is shorter than rev2's because the rev2 fix waves did most of the heavy lifting. Rev3 is the *quality control* pass that catches the things adversarial pressure surfaces — the fixes the per-team scans missed.
