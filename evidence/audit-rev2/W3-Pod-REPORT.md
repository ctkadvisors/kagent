# W3-Pod — agent-pod / agent-loop MEDIUM fixes report

**Date:** 2026-05-07
**Worker:** W3-Pod
**Scope:** `packages/agent-pod/**`, `packages/agent-loop/**`, `docs/CONTEXT-AWARENESS.md`, `docs/MODEL-ROUTING.md`
**Branch:** `main`
**Pushed to:** `origin/main`

---

## 1. Commits landed

| Wave | SHA | Title |
|---|---|---|
| Theme A | `1689b3e` | `fix(agent-pod): defense-in-depth WARN logs + range bounds in pod env parsers (NM3, NM4 follow-ups)` |
| Theme B | `81419f0` | `fix(agent-pod): runtime hardening — keep allowedChildAgents w/ cap, fstat CAS reads, lift write_artifact env to boot (M6, M8, M9)` |
| Theme C | `ff92b86` | `fix(agent-pod): structured failure visibility — default timeout, SIGTERM grace flush, blackboard-fail-open WARN, mtls UNVERIFIED flag (M7, M10, M12)` |
| Theme D | `fffff30` | `feat(agent-pod, agent-loop): context-awareness defense-in-depth — universal get_my_context wireup + tool-aware detector escape (NM5, NM4 detector)` |
| Theme E | `ab15a3e` | `chore(agent-pod): KAGENT_SPEC_SOURCE WARN on env-JSON path + ROADMAP env-JSON deprecation tick (M11)` |
| Theme F | `b08e458` | `docs(context-awareness, model-routing): document escape-hatch caveat, in-flight binding, estimateTokens fallback (NM1, NM2, NM6)` |

All commits include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

### Concurrency note

This worker shared `main` with several parallel agents (W3-Operator, W3-Gateway, W3-Workbench were committing concurrently — observed by the periodic appearance of un-staged changes from `packages/llm-gateway/**`, `packages/workbench-api/**`, and `packages/operator/**` between this worker's edits). All commits used `git commit --only -F <msgfile> <pathspec>` to lock content; `git diff --staged` was implicitly verified by the pre-commit hook's typecheck. No history rewrites; no force-push. Pre-commit hook (`simple-git-hooks` → `pnpm lint-staged && pnpm -r typecheck`) requires Node 22; the ambient shell `node` resolved to Node 23.x and would have failed the `engines` guard, so each commit invocation prepended `~/.nvm/versions/node/v22.22.0/bin` to PATH. No `--no-verify`.

---

## 2. Per-finding summary

### Theme A — context-awareness defense-in-depth

| Finding | Status | File:line | Notes |
|---|---|---|---|
| NM3 | CLOSED | `packages/agent-pod/src/runner.ts` `parseContextSafetyThreshold`, `parseContextPressureThresholdEnv` | Both parsers now log a structured WARN naming the offending value + the legal range + the default the caller will use. Matches the operator-side `parseModelClassesEnv` shape so logs from both sides of the chart-mediated path are searchable with one regex. Defense-in-depth — operator chart's NH3 guard catches misconfig pre-deploy; this WARN catches the non-chart-mediated (manual Job override / future non-chart deploy) case. |
| NM4 | CLOSED | `packages/agent-pod/src/env.ts` `parseContextWindowTokens` | Added `[CONTEXT_WINDOW_TOKENS_MIN=1000, CONTEXT_WINDOW_TOKENS_MAX=2_097_152]` bounds (mirror of the operator-side constants). Three distinct WARN shapes: above-MAX (silent-disable trapdoor), below-MIN (over-trip trapdoor), invalid/non-integer. Out-of-range values drop with graceful degrade rather than failing the run. |
| NM5 | CLOSED | `packages/agent-pod/src/runner.ts` `resolveToolProviders` | `defineGetMyContext` is now wired UNIVERSALLY in the runner via the `kagent-universal-context` provider — no `KAGENT_SPAWN_CHILD_ENABLED` gate, no `if (spawnEnabled)` block. `RunDeps` accepts `tokenUtilizationSnapshot` + `remainingBudgetSeconds`; main.ts threads the same production-shape thunks through. Tests driving `runAgentTask` directly with `Agent.spec.tools = ['get_my_context']` no longer throw "unknown built-in tool". Required main.ts to drop its own `defineGetMyContext` registration (would have collided with `DuplicateToolNameError`). |
| NM4 detector escape | CLOSED | `packages/agent-loop/src/detectors/quality-flags.ts` | Added `spawnToolAdmitted?: boolean` to `ContextPressureOpts` (default `true` for back-compat). When `false`, the detector skips entirely. Runner threads `spec.tools.includes('spawn_child_task') \|\| hasSpawnIntent(spec)` — matches the substrate tool-allowlist's implicit-when-X predicate. Researcher / single-shot agents that legitimately don't delegate no longer get untunable noise in `structuralVerdict.suspicious[]`. |

### Theme B — pod runtime hardening

| Finding | Status | File:line | Notes |
|---|---|---|---|
| M6 | CLOSED | `packages/agent-pod/src/builtin-tools-spawn.ts:283-322` | When `parentCap !== undefined` AND `Agent.spec.allowedChildAgents` is non-empty, the legacy list now enforces in addition to the cap. Previously a cap with `claims.spawn = ['*']` bypassed the GitOps-controlled list. Cap-only deploy path (both legacy lists intentionally empty) preserved by gating on `allow.size > 0 \|\| allowTemplates.size > 0`. |
| M8 | CLOSED | `packages/agent-pod/src/builtin-tools.ts buildBuiltinToolRegistry` | `resolveWriterEnvOrDisabled` lifted out of the handler into `buildBuiltinToolRegistry` closure. Single boot-time WARN announces "storage disabled (...)" when misconfigured; handler closes over the boot-time env. Misconfig now surfaces in pod-startup logs, not on first call (which could be minutes into a long run). |
| M9 | CLOSED | `packages/agent-pod/src/cas-backend.ts PvcCasBackend.read` | Added `maxReadBytes` constructor option (default 8 MiB to match `read_artifact` tool ceiling). Read path now `statSync()` first; oversized reads refuse with structured `cas-backend: refusing to read ...` error before `readFileSync` allocates the full Buffer. |

### Theme C — observability + transient-error robustness

| Finding | Status | File:line | Notes |
|---|---|---|---|
| M7 | CLOSED | `packages/agent-pod/src/svid-client.ts probeGatewayMtls` | Probe now extracts the optional `X-Kagent-Identity-Verified` response header. Verified path: `identityVerifiedHeader` carries the SPIFFE ID + detail string suffix `VERIFIED=spiffe://...`. Unverified path: field omitted, detail suffix `UNVERIFIED`. Caller decides whether to log WARN and how audit emissions flag. The gateway-side header emission is the open question in `docs/GATEWAY-CONTRACT.md §4.3`; agent-pod side is now ready. |
| M10 | CLOSED | `packages/agent-pod/src/runner.ts`, `packages/agent-pod/src/main.ts` | (a) Added `DEFAULT_TASK_TIMEOUT_SECONDS = 1800` stamped at admission time when no timeout is declared. Every admitted task now has a wall-clock ceiling AND an AbortSignal-driven cancellation path the SIGTERM handler can observe. (b) Added `scheduleSigtermGraceFlush` + `GRACE_FLUSH_DEADLINE_MS = 25_000` — best-effort `writeStatus(Failed)` after 25s if the runner hasn't unwound. Unrefed timer doesn't prevent normal exit when the runner returns. |
| M12 | PARTIALLY CLOSED | `packages/agent-pod/src/main.ts:469-490` | Added structured boot-time WARN when `KAGENT_BLACKBOARD_FAIL_OPEN=true` is set, naming the consequence (`{read: [*], write: [*]}` cluster-wide) + the W3-Operator chart-side gate (`agentPod.blackboard.acknowledgeUnsafe=true`) that will land. **Helm-side `acknowledgeUnsafe: true` flag is W3-Operator scope** — filed as a follow-up below. |
| M13 | OUT OF SCOPE | `packages/operator/src/verifier.ts` | Per dispatch — verifier transient retry is W3-Operator scope. SKIPPED. (W3-Operator landed M3 + M13 fix in commit `65ef511`.) |

### Theme D — see Theme A above (NM5 + NM4 detector landed under Theme A in the punchlist's intent, committed under `fffff30` per the dispatch's atomic-commit guidance).

### Theme E — deprecation timer

| Finding | Status | File:line | Notes |
|---|---|---|---|
| M11 | CLOSED | `packages/agent-pod/src/env.ts parseEnv`, `docs/ROADMAP.md` line 91 | (a) Pod-side WARN when `specSource === 'env-json'` naming the v0.3.0-cas removal target + a `mixed`-case UNEXPECTED warn for partial-mount edge cases. `KAGENT_SPEC_SOURCE` is already stamped on `process.env` (main.ts:117) and surfaced via OTel `kagent.spec.source` attribute. (b) ROADMAP.md Phase 4 §"Move Agent + Task spec injection off env JSON" checked off with audit-rev2 M11 timeline note. **K8s-Pod-annotation stamp on the actual Pod metadata is W3-Operator scope** (operator-side at Job-create time). |

### Theme F — doc fixes

| Finding | Status | File:line | Notes |
|---|---|---|---|
| NM1 | CLOSED | `docs/CONTEXT-AWARENESS.md §7`, `docs/MODEL-ROUTING.md §6` | Callouts naming the resolver path (`model-class-resolver.ts:144-145`) + migration prescription. Pinned-model Agents lose context-awareness silently — operators expecting cluster-wide safety-net should know. |
| NM2 | CLOSED | `docs/CONTEXT-AWARENESS.md §7` | Callout: in-flight Pods are bound to spawn-time `contextWindowTokens`. Helm upgrades affect newly-dispatched Pods only. Lowering the window mid-flight does not constrain pre-upgrade Pods. |
| NM6 | CLOSED | `docs/CONTEXT-AWARENESS.md §8` | Callout: when gateway doesn't report `usage.{inputTokens,outputTokens}`, the executor falls back to `estimateTokens` heuristic (20–40% off depending on tokenization). The 5% margin between Piece 3's safety-net and the upstream 100% reject absorbs most drift. Verification path: inspect `llm_call` trace entries for `usage_source: 'estimate'` marker (forthcoming). |

---

## 3. Verification

| Check | Result |
|---|---|
| `cd packages/agent-loop && npm run typecheck` | green |
| `cd packages/agent-loop && npm run lint` | green |
| `cd packages/agent-loop && npm test` | **174 tests passing** (was 171 baseline; +3 new for NM4 detector escape) |
| `cd packages/agent-pod && npm run typecheck` | green |
| `cd packages/agent-pod && npm run lint` | green |
| `cd packages/agent-pod && npm test` | **530 tests passing** (was 506 baseline; +24 new across NM3, NM4 env, M6, M9, M7 svid, M10 default-timeout, NM5 universal wireup, M11 env-json) |
| `pnpm -r typecheck` (via pre-commit hook on each commit) | green throughout |

Total new tests: 27. No pre-existing tests were broken (some required updates to acknowledge the universal `kagent-universal-context` provider's appearance in the runner's tool list — these were minor filter additions, not behavior changes).

---

## 4. Wired-but-dead-code SCAN — agent-pod / agent-loop scope

Step 1 grep per `WIRED-BUT-DEAD-CODE-PARADIGM.md`:

```
grep -rnE 'deps\.\w+\?\.\(' packages/agent-pod/src --include='*.ts' --exclude='*.test.ts'
grep -rnE 'deps\.\w+\?\.\(' packages/agent-loop/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/agent-pod/src packages/agent-loop/src --include='*.ts' --exclude='*.test.ts'
```

### Findings

| Site | Classification | Notes |
|---|---|---|
| `builtin-tools-spawn.ts:364 deps.remainingBudgetSeconds?.()` | **CSPREAD** | Production wireup at `main.ts:322-329` (post-NM5 outer-scope lift). Wired conditionally on `runConfig.timeoutSeconds !== undefined` — when no per-task timeout is declared, the budget thunk is intentionally absent (no clamp on child timeouts). Documented at the wireup site. |
| `builtin-tools-spawn.ts:385 deps.getTraceparent?.()` | **CSPREAD** | Production wireup at `main.ts:441-443` — wired conditionally on `isOtelEnabled(process.env)`. When OTel is off, child trace context propagation is intentionally absent. |
| `builtin-tools-wait.ts:124, :207 deps.remainingBudgetSeconds?.()` | **CSPREAD** | Same pattern as spawn — production wireup forwards the same closure when `runConfig.timeoutSeconds` is set; absent otherwise. |
| `builtin-tools.ts:1132 deps.remainingBudgetSeconds?.()` (`defineGetMyContext`) | **CSPREAD** | NM5 wired this universally via `runner.ts:resolveToolProviders` reading `RunDeps.remainingBudgetSeconds`. Production main.ts threads the same closure through. When the closure is undefined (no per-task timeout), `secondsRemaining` is intentionally absent from the introspection tool's output. |
| `builtin-tools.ts:1153 deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }` (`defineGetMyContext`) | **CSPREAD (post-NM5 fix)** | Was the original NB1 wired-but-dead site. Status now: production wires `tokenUtilizationSnapshot` via `main.ts:358 (buildTokenUtilizationBridge) → main.ts:666 (RunDeps) → runner.ts:762-763 (defineGetMyContext deps)` — confirmed the universal-context provider's registration threads the live-budget thunk. The fallback fires only when tests omit the dep (test-injection ergonomic) — production never observes `{used: 0, modelWindow: null}`. |

### Net summary

**Zero new wired-but-dead findings in agent-pod / agent-loop scope.** All optional-call sites are CSPREAD-class (legitimate feature flags / test-injection seams) with production wireup confirmed. The original NB1 site (`tokenUtilizationSnapshot`) was repaired by this wave's NM5 fix — the production threading is now: `buildTokenUtilizationBridge` (main.ts) → `RunDeps.tokenUtilizationSnapshot` (passed to `runAgentTask`) → `resolveToolProviders` reads it and forwards into `defineGetMyContext`'s deps in the universal-context provider. The fallback `?? { used: 0, modelWindow: null }` is now reachable only in test paths that don't supply the dep.

---

## 5. Follow-ups (filed for the arbiter)

These are out of W3-Pod scope by the dispatch but were identified during this wave:

### M12 follow-up — Helm-side `acknowledgeUnsafe` flag

**Scope:** `packages/operator/charts/kagent-operator/**` (W3-Operator).

**Issue:** This wave added the pod-side WARN when `KAGENT_BLACKBOARD_FAIL_OPEN=true` is set, naming the consequence + the chart-side gate. The chart-side gate (`agentPod.blackboard.acknowledgeUnsafe: true`) does not yet exist. Need: refuse Helm install when `agentPod.blackboard.failOpen=true` without `agentPod.blackboard.acknowledgeUnsafe=true`. Pattern matches the NH3 chart-render-time fail W1-Operator already shipped.

### M11 follow-up — K8s Pod annotation for spec-source

**Scope:** `packages/operator/src/job-spec.ts` (W3-Operator).

**Issue:** This wave added the pod-side env-JSON deprecation WARN. The audit's M11 also asked for a K8s Pod annotation (`kagent.knuteson.io/spec-source: configmap | env-json | mixed`) stamped at Job-create time. The annotation is operator-side — the operator's job-spec builder already knows whether it's projecting via ConfigMap or env-JSON for that Pod. Adding the annotation closes the loop so `kubectl describe pod` reveals the path without exec'ing into the pod to read `process.env.KAGENT_SPEC_SOURCE`.

### M7 follow-up — gateway X-Kagent-Identity-Verified emission

**Scope:** `packages/llm-gateway/**` (W3-Gateway / Wave 4).

**Issue:** This wave added agent-pod-side parsing of `X-Kagent-Identity-Verified` in `probeGatewayMtls`. The gateway side does not yet emit this header. Per `docs/GATEWAY-CONTRACT.md §4.3`, the open question is whether the gateway should propagate the SPIFFE ID it verified during the mTLS handshake into the response header. Until then, the probe records `mtlsSupported: true (UNVERIFIED)` for every successful probe. Closing this opens the door to promoting the WARN to INFO + flagging audit emissions as VERIFIED.

### NM6 follow-up — `usage_source: 'estimate'` trace marker

**Scope:** `packages/agent-loop/src/executor.ts` + `trace.ts` (Wave 5 LOW or operator follow-up).

**Issue:** The NM6 doc callout names a "verify by inspecting llm_call trace for `usage_source: 'estimate'` marker (forthcoming)" — the marker doesn't exist yet. Adding `usage_source: 'reported' | 'estimate'` to `llm_call` trace entries closes the observability loop so operators can see at a glance which calls were on the heuristic path. Out of W3-Pod scope (LOW; touches the executor's usage-handling code path).

### Detector predicate hoist

**Scope:** `packages/agent-pod/src/runner.ts` (next refactor).

**Issue:** The NM4 detector escape duplicates the `hasSpawnIntent(spec)` predicate in `runner.ts` — that predicate is the same one used in the substrate tool-allowlist's implicit-when-X path. Currently both call sites read `spec.allowedChildAgents.length > 0 || spec.allowedChildTemplates.length > 0`. Future cleanup: hoist `hasSpawnIntent` to a shared helper module (or export it from `env.ts`) so the detector + allowlist read the same source of truth verbatim.

---

## 6. Out of scope (untouched)

- W3-Operator: H8 status-patch race, M21 (substrate health emission — landed by W3-Operator separately at `1ae2718`), M13 verifier transient retry (landed at `65ef511`), all chart fail-guards, all ROADMAP-tracked deliverables not specifically called out here.
- W3-Gateway: `packages/llm-gateway/**` not touched.
- W3-Workbench: `packages/workbench-api/**`, `packages/workbench-ui/**` not touched.
- LOWs (Wave 5): all deferred per dispatch.
- Operator-side chart values (`packages/operator/charts/kagent-operator/**`) not touched.

---

## 7. Net delta

| Bucket | Closed in this wave |
|---|---|
| MEDIUM (audit-rev2 C2 §4 NM*) | NM3, NM4, NM5, NM6, NM4 detector escape |
| MEDIUM (audit-rev2 C2 §1) | M6, M7 (agent-pod side), M8, M9, M10, M11, M12 (agent-pod side) |
| Documentation gaps | NM1 (escape-hatch), NM2 (in-flight binding), NM6 (estimateTokens) |

**Test-coverage delta:** +27 new tests (3 in agent-loop, 24 in agent-pod). All pre-existing tests preserved; tests that asserted the absence of the universal-context provider were updated to filter it out of their assertions (no behavior regression).

---

## 8. Blockers

None.

---

## 9. Closing note on the wired-but-dead-code paradigm

The original NB1 finding (`tokenUtilizationSnapshot` unwired in production) is the canonical example the WIRED-BUT-DEAD-CODE-PARADIGM document was built around. NM5 in this wave repaired the production wireup site by lifting `defineGetMyContext` registration into the runner's universal-context provider and threading the snapshot dep through `RunDeps`. The fix shape exactly matches the paradigm doc's "every wired-but-dead fix should: wire the dep at the production callsite + add a regression test that drives the full production wireup" prescription — `main.test.ts`'s NB1 + NH1 regression suites were updated to drive the `RunDeps`-based universal wireup, which is now the shape production code observes.

The remaining optional-call sites in the agent-pod / agent-loop scope are all CSPREAD (legitimate feature flags) with documented conditions at the wireup site. No new fix candidates routed to the arbiter from this scope.
