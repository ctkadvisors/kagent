# REV3 Fix Report — `@kagent/agent-loop-vercel-ai` (rev3-fix-vercel-ai)

**Date:** 2026-05-07
**Agent:** rev3-fix-vercel-ai
**HEAD at start:** `10c2a0c`
**Final HEAD:** `74965e4`
**Scope (touched files):**
- `packages/agent-loop-vercel-ai/src/runner.ts`
- `packages/agent-loop-vercel-ai/src/runner.test.ts`
- `packages/agent-loop-vercel-ai/src/context-safety-middleware.ts`
- `packages/agent-loop-vercel-ai/src/context-safety-middleware.test.ts`
- `packages/agent-loop-vercel-ai/src/trace-sink-adapter.ts`
- `packages/agent-loop-vercel-ai/src/trace-sink-adapter.test.ts`
- `packages/agent-loop-vercel-ai/src/capability-tool-wrapper.ts`
- `packages/agent-loop-vercel-ai/src/index.ts`

---

## Findings closed

| # | Severity | SHA | One-line |
|---|---|---|---|
| **R3-B1** | BLOCKER | `b37d9cc` | Thread `maxSteps` to `streamText` via `stopWhen: stepCountIs(input.maxSteps ?? 16)`. Adds 2 regression tests (stopWhen-presence + multi-step tool loop). |
| **C2R3-LOW-2** | LOW | `99f6171` | Optional-chain `result.usage.{inputTokens,outputTokens}?.total` in `wrapGenerate` — non-conformant providers no longer crash the safety-net. |
| **R3-LOW-1** | LOW | `99f6171` | Add `estimateTokens` fallback in both `wrapGenerate` + `wrapStream` for usage-less providers (Cloudflare Workers AI). Buffers text-delta chunks for stream-side estimate. |
| **R3-LOW-2** | LOW | `98623fe` | `buildTraceSinkBridge` accepts `traceSinks?: readonly TraceSink[]`; fan-out helper forwards every `TraceEntry` to every sink with sync/async error swallowing. Runner threads field through. |
| **R3-LOW-3** | LOW | `1c5817d` | Doc-only — TSDoc on `wrapToolWithCapabilityCheck` now contains a prominent "CALLER RESPONSIBILITY — JWKS verification" section + matching note on `index.ts` re-export. |
| **R3-LOW-4** | LOW | `74965e4` | Replaced detector-test stub (which admittedly tested the negative shape) with a higher-fidelity fake that drives `wrappedModel.doGenerate(...)` through middleware so cumulative tokens accumulate realistically. Test now asserts `flags.toContain('context_pressure_ignored')`. |

All 6 punchlist items in scope closed.

---

## Verification

```
cd packages/agent-loop-vercel-ai
pnpm typecheck   # PASS — no errors
pnpm lint        # PASS — 0 warnings
pnpm test        # PASS — 42 tests (was 36; +6 new tests)
```

New tests:
- `runner.test.ts` — `threads maxSteps to streamText.stopWhen so multi-step tool loops actually iterate (R3-B1)`
- `runner.test.ts` — `default maxSteps allows a multi-step tool loop (≥2 LLM calls before completion) (R3-B1)`
- `runner.test.ts` — `detector fires context_pressure_ignored under realistic middleware accounting (R3-LOW-4)` (replaces the dishonest stub-bypass test)
- `context-safety-middleware.test.ts` — `does NOT throw on a usage shape missing .total fields (C2R3-LOW-2 optional chaining)`
- `context-safety-middleware.test.ts` — `falls back to estimateTokens when streaming finish chunk lacks usage entirely (R3-LOW-1)`
- `trace-sink-adapter.test.ts` — `forwards every emitted entry to registered TraceSinks (R3-LOW-2)`
- `trace-sink-adapter.test.ts` — `swallows sink emit() errors so a buggy sink cannot crash the run (R3-LOW-2)`

Net: 6 new tests; the dishonest "negative shape" detector test was rewritten honestly (+1 -1 net to the test count it claimed).

---

## Smoke verification (R3-LOW-4 test acts as the integrated smoke)

The R3-LOW-4 replacement test is itself the requested smoke: a fake `streamText` drives `wrappedModel.doGenerate(...)` through `wrapLanguageModel(...)`'s middleware path on three rounds (350 tokens each). Asserts:
- `result.budget.cumulativeInputTokens === 750`
- `result.budget.cumulativeOutputTokens === 300`
- `result.budget.contextWindowTokens === 1000`
- `result.flags` contains `'context_pressure_ignored'`

This is the first test in the package that exercises the integrated `wrapLanguageModel + onStepFinish + middleware accounting + budget extraction + detector` chain end-to-end. Previously every test bypassed at least one of those boundaries.

Combined with the R3-B1 multi-step regression test, the runner test suite now catches:
1. `stopWhen` not threaded → fails the maxSteps test (B1).
2. Detector contract broken → fails the realistic-accounting test (LOW-4).
3. Middleware crash on usage shape → fails the optional-chaining test (LOW-2).
4. Estimator silently no-ops → fails the streaming-fallback test (LOW-1).
5. Trace sink dropped → fails the fan-out test (LOW-2).

---

## Scope discipline

Only `packages/agent-loop-vercel-ai/**` was touched. No operator, agent-pod, agent-loop, gateway, workbench, or chart files modified. Each commit used `git commit --only -F <msg> <pathspec>` to constrain the staged diff to the intended files; sibling agents' work was not affected.

---

## Net result

The W4 reference adapter at `@kagent/agent-loop-vercel-ai` now actually runs a multi-step agent loop, observes the safety-net even on usage-less providers, fans trace data out to real `TraceSink`s, and documents the JWT-verify caller-responsibility contract. The R3 audit's "TRUE-WITH-FIVE-CAVEATS" framing reduces by one caveat — the reference adapter is no longer half-built. The remaining four caveats (env reader, status writer, JWT verification, OTel semconv) remain consumer-side integration work as documented in the original W4 report.
