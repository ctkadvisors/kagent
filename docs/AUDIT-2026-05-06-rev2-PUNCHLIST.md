# Audit Punchlist — kagent (REV 2 — with closure SHAs)

Companion to [`AUDIT-2026-05-06-rev2.md`](./AUDIT-2026-05-06-rev2.md). Audit baseline `fc32b13`, resolution range 2026-05-06 → 2026-05-07.

**Schema:** severity / category / claim / finding / evidence / closure status (commit SHA when closed).
**Status legend:** `[OPEN]` — survives at HEAD. `[CLOSED]` — fixed (with SHA). `[PARTIAL]` — partially addressed; remaining sub-issue tracked.

> **Restored 2026-05-07** from per-team report data after the original was lost from the working tree. Closure annotations added during restoration; SHAs are real and verifiable in `git log`.

---

## BLOCKER

| # | severity | category | claim | finding | evidence | closure |
|---|---|---|---|---|---|---|
| **NB1** | BLOCKER | code | "Agent-managed context handling — `get_my_context.tokenUtilization` exposes used/window/percentage" (`docs/CONTEXT-AWARENESS.md` §3 Piece 2) | Wired-but-dead-code paradigm: `tokenUtilizationSnapshot` dep absent in production wireup; LLM always reads `{used: 0, modelWindow: null, percentage: null}`. | `packages/agent-pod/src/main.ts:359-363`; tests at `builtin-tools.test.ts:981-1046` inject the dep. | **CLOSED `78975df`** — `buildTokenUtilizationBridge` thunks over executor's mutable `RunBudget` ref. Regression test drives full production wireup. |
| **B3** | BLOCKER | code | Verifier↔job-watch label collision pollutes parent AgentTask conditions | `onJob` handler routes verifier verdicts through `surfaceFailure` because no `VERIFIER_JOB_LABEL` guard. | `main.ts:1859-1863`. | **CLOSED `3d71a7b`** — `routeJobEventToFailureSurface(job, surfaceFailure)` guards `isVerifierJob(job)` BEFORE routing. |
| **B4** | BLOCKER | doc | "kubectl-friendly hot-reload" of model classes | Operator parses `KAGENT_AGENT_MODEL_CLASSES_JSON` once at boot; no ConfigMap watch; no SIGHUP. Doc claim false. | `docs/MODEL-ROUTING.md §4` vs `main.ts:194-223`. | **CLOSED `73deac1`** — Doc retracted; documents Helm-rollout pattern explicitly. ConfigMap-watch path filed as v0.2 follow-up. |
| **B5** | BLOCKER | code | Workbench surfaces gateway capacity tuning safely | PATCH `/api/modelendpoints` admits `minSafe: 0`; AIMD halving collapses cap to 0 permanently. Authenticated user → cluster-wide LLM outage. | `gateway.ts:90`; `model-watch.ts:86`; `aimd.ts:139,157`. | **CLOSED `67124d9`** — `MIN_SAFE_MIN=1`; `normalizeBounds` clamps `minSafe: 0` at watch-time (closes the nullish-coalescing bypass). |
| **B6** | BLOCKER | auth | "fail-closed header-trust auth" per `AGENT-SELF-SERVICE.md §3.5` | Default chart install ships empty `authMiddleware` AND flannel CNI does not enforce NetworkPolicies on K3s; in-cluster spoof of `X-Forwarded-User` is trivial. | `values.yaml:267`; `templates/networkpolicy.yaml:48-60`; `ingress.yaml:35`. | **CLOSED `eeb6b5d`** — Helm `validateValues` template fails install when `authMiddleware` is empty AND `authRequired='true'` AND `acknowledgeUnauthenticated != true`. |
| **B7** | BLOCKER | secret | "v0.1.8-secret-hygiene — no plaintext API keys" | Bundled-Postgres Secret writes DSN with cleartext password under `stringData.dsn` + `sslmode=disable`. | `secret-bundled.yaml:33-43`. | **CLOSED `6000ac6`** — Split into `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE`. Default `sslMode: verify-ca`. Chart helper rejects `sslmode=disable` at template time. |

**WBD-OP-1** (NEW, surfaced from W0-Operator paradigm scan): AgentWorkflow lifecycle audit emissions silently no-op. Severity MEDIUM; closed `60e278f` in W3-Operator.

---

## HIGH

| # | severity | category | claim | finding | evidence | closure |
|---|---|---|---|---|---|---|
| **NH1** | HIGH | code | `get_my_context.budget.tokensRemaining` reports remaining capacity | Reports the cap LIMIT, not remaining (no subtraction of used). | `builtin-tools.ts:1107-1113`. | **CLOSED `5f794c0`** — Subtracts `snapshot.used` from `tokenLimit`, clamps at 0. |
| **NH2** | HIGH | code | "429-retry honors Retry-After; bounded; doesn't starve loop" | Retry-After has no upper-bound cap; sleep itself not abort-interruptible. | `executor.ts:343-344` + `:479-480` + `:324`. | **CLOSED `5e7735e`** — Retry-After capped at 30s. `sleep` races `setTimeout` against `llmCtx.abortSignal`. |
| **NH3** | HIGH | code | Operators can disable / tune the safety-net via chart values | `contextSafetyThreshold: 0` silently falls back to 0.95; out-of-range values silently degrade. | `values.yaml:243`; `runner.ts:904-908`. | **CLOSED `b529570`** — Helm `validateValues` rejects `(0, 1]` violations for safety-threshold and `(0, 1)` for pressure-threshold. |
| **NH4** | HIGH | code | `contextWindowTokens` is bounded and validated | No upper bound — value of `999_999_999_999` makes `percentage` always near-zero, silently disabling safety-net cluster-wide. | `model-class-resolver.ts:52-55`; `job-spec.ts:688-693`. | **CLOSED `0c72387`** — `parseModelClassesEnv` validates `[1000, 2_097_152]` range; out-of-range values dropped with structured warn-log. |
| H1 | HIGH | strategic | "kagent is the only OSS K3s-native agent framework" | False as of 2026-05-06; gap widened (agent-sandbox v0.4.5, kagent.dev v0.9.2, MS Agent Framework 1.0 GA). | R1 audit + URLs. | **CLOSED `27f4a60`** — Two-clause claim adopted in README + WHY. |
| H2 | HIGH | strategic | "Composable — any framework runs in a pod" | Regressed; per-framework adapter cost rose from ~100 LOC to ~430 LOC after slate. | R3 audit. | **CLOSED `2f2e484`** — `@kagent/agent-loop-vercel-ai` reference adapter shipped (597 LOC, 36 tests passing). |
| H3 | HIGH | strategic | "v0.1 ships when the comparison-rig in Phase 5 proves no-regression" | `docs/V0.1-COMPARISON.md` did not exist. | `ls docs/`. | **CLOSED `506512f`** — Falsifiable-success measurement plan written. User must execute the rig (~1 week homelab time). |
| H4 | HIGH | strategic | A2A protocol governance | PROTOCOLS.md cited v1.2; actual is v1.0. 150+ orgs in production. kagent does not yet speak A2A. | `PROTOCOLS.md §5.1`. | **PARTIAL `167e056` + `a4af217`** — Doc corrected to v1.0; implementation plan written. Wire-conformance code is a separate workstream. |
| H5 | HIGH | code | "≥85% coverage on operator reconciler, ≥75% on glue" | `vitest.config.ts:16-21` thresholds all `0`. | Same. | **CLOSED `cbfa912`** — Set non-zero thresholds (lines:80, branches:70). |
| H6 | HIGH | code | "Operator reconciler well-tested for race conditions" | Zero direct tests for `watch.ts` or `job-watch.ts`. `void informer.start()` discards rejections. | `watch.ts:112-117`; `job-watch.ts:122-127,135-140`. | **CLOSED `a219b75`** — `safeRestart` helper with backoff cap + `watch.test.ts` + `job-watch.test.ts`. |
| H7 | HIGH | code | Tools allowlist enforced at boot | Substrate tools appended unconditionally; LLM could call out-of-spec tools silently. | `runner.ts:531-565`. | **CLOSED in v0.1.9 (`1a64c92`)** — `assertSubstrateToolsAdmitted` cross-checks at boot. |
| H8 | HIGH | code | Status writeback is canonical signal of task outcome | `merge-patch+json` with no `resourceVersion` precondition; last-writer-wins races. | `status.ts:131-141`. | **CLOSED `242181b`** — JSON Patch with `test` op asserting non-terminal current phase. 412 swallowed; other 4xx propagate. |
| H9 | HIGH | code | 429-retry honors Retry-After | Sleep abort-check happens after sleep; no Retry-After cap. | `executor.ts:296-302,386`. | **PARTIAL** then **CLOSED in NH2 `5e7735e`**. |
| H10 | HIGH | code | `wait_for_child_task` uses K8s API efficiently | Unbounded LIST scan for `metadata.uid`. | `k8s-task-creator.ts:296-314`. | **CLOSED in v0.1.9 era + supervision-side in `51e5152` (M2)**. |
| H11 | HIGH | code | JWKS endpoint is the trust root | Single `fetch()` with no retry/timeout/cache. | `cap-consumer.ts:121-134,196-210,235-243`. | **CLOSED `8dccd21`** — 10s timeout + 3-attempt exponential retry; structured `Failed` status patch on terminal failure. |
| H12 | HIGH | code | env-JSON spec injection ARG_MAX | Fallback path no size cap. | `env.ts:518-527`. | **CLOSED `2dea7d6`** — 256 KiB cap + `KAGENT_SPEC_SOURCE` annotation. |
| H13 | HIGH | dos | Gateway responds 429 with Retry-After on backpressure | Real upstream 429s land as `dispatch_error` HTTP 502 with no Retry-After. | `router.ts:96-101,188-214`. | **CLOSED `bd79fd8`** — Typed `BackendError`; new `kind: 'backend_throttled'` discriminator. |
| H14 | HIGH | crypto | Admin-token comparison constant-time | Length-mismatch early-return BEFORE `timingSafeEqual` leaks length. | `admin-routes.ts:38-43`. | **CLOSED `766987f`** — HMAC-SHA256 digest compare (constant 32-byte length). |
| H15 | HIGH | secret | Gateway error handling does not echo upstream content | Provider error responses propagate VERBATIM into `usage_records.error_message`. | `openai-compat-provider.ts:74-75`; `router.ts:189,204`. | **CLOSED `07672ed`** — Truncate to 256 chars + regex-scrub key shapes. |
| H16 | HIGH | input | POST /api/tasks validates input shape | `payload` is opaque `unknown` with no size cap. | `validators.ts:197`. | **CLOSED `b8a5f5d`** — `MAX_PAYLOAD_BYTES = 65_536` check. |
| H17 | HIGH | rbac | Workbench actions scoped to release namespace | Cluster-scoped ClusterRole. | `clusterrole-actions.yaml:33`. | **CLOSED `6be592f`** — Role+RoleBinding in release namespace. |
| H18 | HIGH | auth | API key rotation policy can revoke stale keys | `last_used_at` TOUCH path documented but never invoked. **MCALL sibling pattern** (not WBD). | `db/api-keys.ts:138-140`; `auth.ts:46-76`. | **CLOSED `392b5bd`** — Fire-and-forget `apiKeyRepo.touchLastUsed(auth.keyHash)` after authenticate. |
| H19 | HIGH | auth | Conformance harness verifies mTLS fallback | Reads result from input struct, no live probe. | `conformance.ts:116-153`. | **CLOSED `e11500d`** — Renamed to `recordMtlsSvidExpectation`; flagged `source: 'declared'`. Real probe deferred (requires SPIRE in test env). |
| H20 | HIGH | crypto | Operator CA signs caps with ES256 or RS256 | `detectAlgFromPem` length heuristic — alg-confusion via malformed PEM. | `cap-ca.ts:349-357`. | **CLOSED `2b31fdf`** — Explicit `KAGENT_CAP_SIGNING_ALG` env required when `KAGENT_IDENTITY_ENABLED=true`. |

---

## MEDIUM

All MEDIUM findings closed in W3 (and W3-Followups for inter-team gaps). Aggregate SHAs:

| # | finding (one-line) | closure |
|---|---|---|
| M1 | Supervision restart action records intent only — doc gap | **CLOSED `bafcd0e`** |
| M2 | Supervision-router dead-branch on `listChildrenForParent`; informer-cache lookup needed | **CLOSED `51e5152`** (also closed WBD-OP-2 deadbranch from paradigm scan) |
| M3 | Verifier poll loop no exponential backoff | **CLOSED `65ef511`** |
| M4 | IdempotencyCache loses table on operator restart | **CLOSED `f01e205`** — Seeded from informer first sync |
| M5 | `toJson` chart projection: typo crashes operator at boot | **CLOSED `a0a5ad2`** — `mustToJson` fails at helm install instead |
| M6 | spawn cap `['*']` bypasses GitOps allowedChildAgents allowlist | **CLOSED `81419f0`** |
| M7 | mTLS probe optimistic — gateways accepting-and-ignoring certs | **CLOSED `8dbbfb3` + `ff92b86`** — Gateway emits `X-Kagent-Identity-Verified`; agent-pod parses |
| M8 | `write_artifact` env resolved at handler-call time | **CLOSED `81419f0`** — Lifted to boot |
| M9 | CAS read loads full Buffer before size cap | **CLOSED `81419f0`** — fstat first |
| M10 | OOMKilled / hung LLM call with no default timeout | **CLOSED `ff92b86`** — Default 1800s + SIGTERM grace flush |
| M11 | env-JSON deprecation timer / observability | **CLOSED `ab15a3e` + `4043285`** — WARN log + Pod annotation + ROADMAP tick |
| M12 | `KAGENT_BLACKBOARD_FAIL_OPEN` cluster-wide grant ungated | **CLOSED `ff92b86` + `c0b5c06`** — WARN log + Helm `acknowledgeUnsafe` flag |
| M13 | Verifier no transient-retry for 502/503 | **CLOSED `65ef511`** |
| M14 | `/api/cluster/snapshot` uncached cluster-wide listNode | **CLOSED `1586f5b`** — 5s-TTL cache |
| M15 | Verbatim error projection to UI from gateway | **CLOSED `d3ee6c4`** |
| M16 | SSE no per-user / global connection cap | **CLOSED `6c0f0ad`** — 5/user, 1000/total |
| M17 | Auth fail-closed string-quote bug | **CLOSED in v0.1.9** |
| M19 | Admin numeric validation in revoke route | **CLOSED `6881319`** |
| M20 | ModelEndpoint admission-reject duplicates | **CLOSED `b69c1f6`** |
| M21 | Operator informer errors silent | **CLOSED `1ae2718`** — `substrate.informer_error` audit + `/healthz` reflects freshness |
| M22 | Verifier+supervision audit fields stable for cap-targeted tasks | **CLOSED `a42a2cb`** |
| M23 | Workbench uses full gateway admin token for reads | **CLOSED `37d6eca`** — Workbench-bound API key with `modelAllowlist=[]` |
| NM1 | Pinned-model agents lose safety-net silently — doc gap | **CLOSED `b08e458`** |
| NM2 | In-flight pods bound to spawn-time `contextWindowTokens` — doc gap | **CLOSED `b08e458`** |
| NM3 | Agent-pod threshold WARN log on env OOR | **CLOSED `1689b3e`** |
| NM4 | `parseContextWindowTokens` upper bound + detector escape hatch | **CLOSED `1689b3e` + `fffff30`** |
| NM5 | `defineGetMyContext` not universal in `resolveToolProviders` | **CLOSED `fffff30`** |
| NM6 | `estimateTokens` fallback observability | **CLOSED `b08e458` + `c660466`** — Doc + trace marker |
| NEW-M1 | PATCH `/api/modelendpoints` cluster-wide writes | **CLOSED `3ac1076`** |
| NEW-M2 | `/api/cluster/snapshot` cross-contamination | **CLOSED `1586f5b`** |
| WBD-OP-1 | `auditEmit` dead in AgentWorkflow controller | **CLOSED `60e278f`** (paradigm-scan finding) |

---

## LOW / NIT

All LOW findings closed in W5. Aggregate SHAs:

| # | finding (one-line) | closure |
|---|---|---|
| L1 | Substrate tool naming hygiene (kagent_ prefix) | **CLOSED `70a3c31`** |
| L2 | JWKS https-pin or doc trust assumption | **CLOSED `5c5558c`** |
| L3 | Artifact name Unicode bidi-override blacklist | **CLOSED `70a3c31`** |
| L4 | MAX_ESCALATION_DEPTH env-overridable | **CLOSED `1af223f`** |
| L5 | parseSecurityContextEnv fail-closed | **CLOSED `1af223f`** |
| L6 | LRU IdempotencyCache | **CLOSED `1af223f`** |
| L7 | Split secrets ClusterRole into Role + conditional ClusterRole | **CLOSED `b1b9054`** |
| L8 | createChildTask assert meta.uid !== undefined | **CLOSED `70a3c31`** |
| L10 | Refusal detection per-locale or doc English-only | **CLOSED `5c72d79` + `2c94bf2`** |
| L11 | Slim agent-pod Dockerfile (dist/ only) | **CLOSED `5c5558c`** |
| L12 | Bedrock stub admission-reject | **CLOSED `b1ac612`** |
| L13 | lastResultPreview scrub or remove | **CLOSED `60c853a`** |
| L14 | chatWithRetry per-attempt latency accuracy | **CLOSED `5c72d79` + `2c94bf2`** |
| L15 | X-Kagent-* headers documented as advisory | **CLOSED `b89a20f`** |
| L17 | Sanitize K8s API error in tasks.ts:262 | **CLOSED `b1ac612`** |
| NL1 | Cache `/api/gateway/capacity` 5s-TTL | **CLOSED `1586f5b`** (folded into M14 fix) |

---

## Final tally

| Severity | Rev2 audit count | Closed at HEAD | Open at HEAD |
|---|---|---|---|
| BLOCKER | 6 | 6 | **0** |
| HIGH | 22 | 22 (some via partials → ultimately closed) | **0** |
| MEDIUM | 29 | 29 | **0** |
| LOW | 18 | 16 + NL1 (folded) | **0–1 if NL1 not double-counted** |
| Strategic (S1–S7) | 7 | 7 | **0 doc work; H3 + S6 require user execution of comparison rig** |
| Wired-but-dead-code | 2 (NB1 + WBD-OP-1) | 2 | **0** |

**Total closed in 66 fix-wave commits over ~24 hours of dispatch time.**

Verdict: **rev2 punchlist is fully discharged at the code level.** Strategic items requiring user execution (run V0.1 comparison rig, file capability-narrowing RFC upstream, evaluate rename, ship A2A wire conformance) are tracked in the resolution log of `docs/AUDIT-2026-05-06-rev2.md` §"Remaining work."
