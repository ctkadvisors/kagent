# W5-Gateway — LOW-severity fix wave (workbench-api / llm-gateway / docs scope)

**Date:** 2026-05-07
**HEAD start:** `fc32b13`
**HEAD end:** `b89a20f`
**Operator:** W5-Gateway

Three atomic commits landed on `origin/main`. All verifications green
across `@kagent/llm-gateway`, `@kagent/workbench-api`, and
`@kagent/workbench-ui` (typecheck + lint + tests + UI build).

---

## 1. Scope as briefed

LOW-severity items from C3 in gateway-stream surfaces:
- L12 — bedrock stub throws at runtime
- L13 — `lastResultPreview` exposes 200 chars of arbitrary task output
- L15 — `X-Kagent-*` headers documented without "advisory" framing
- L17 — raw K8s error echo in 500 body

**Out of scope (delegated):** pod LOWs (W5-Pod), operator LOWs
(W5-Operator), NL1 (already shipped in W3-Gateway commit `1586f5b`),
final wired-but-dead arbiter scan.

## 2. Commits

### Commit 1 — Theme A: gateway robustness (L12 + L17)

`b1ac612` `fix(llm-gateway, workbench-api): clearer bedrock-stub error + sanitized k8s error message (L12, L17)`

**L12 — bedrock stub upgrade (gateway scope of the fix):**

The directive allowed the gateway-side fix to be a "clearer
boot-time error + documentation" since the operator-side admission
webhook lives outside gateway scope (W5-Operator). Three changes:

- `packages/llm-gateway/src/providers/bedrock-provider.ts` — runtime
  throw is now a discriminator-named `BedrockNotImplementedError`
  exported alongside `BEDROCK_NOT_IMPLEMENTED_ERROR_NAME` so call
  sites can branch without string-matching. Message names the
  missing dep (`@aws-sdk/client-bedrock-runtime`), enumerates
  supported alternatives, and points at the file with the re-enable
  recipe.
- `packages/llm-gateway/src/model-watch.ts` — adds an
  observation-time `console.warn` on first observation of any
  `ModelEndpoint` whose `spec.backendKind === 'bedrock'`, so
  operators see the structured diagnostic before any traffic hits
  the runtime stub. De-duplicated by `(namespace,name)` to keep
  steady-state resyncs quiet.
- `docs/MODEL-ROUTING.md` — new §6.2 "Backend support matrix —
  what `ModelEndpoint.spec.backendKind` accepts in v1" with the
  status table and the re-enable recipe. Cross-links the
  operator-side admission gap that W5-Operator owns.
- `packages/llm-gateway/src/providers/provider-factory.test.ts` —
  two new regression tests confirming both `chatCompletion` and
  `chatCompletionStream` throw the named error with the expected
  message contents.

**L17 — sanitised K8s error in `/api/tasks` 500:**

`packages/workbench-api/src/routes/tasks.ts` — the catch-all 500
branch previously echoed `err.message` verbatim
(`K8s API call failed: <raw apiserver text>`). Apiserver errors
can include internal hostnames, RBAC rule names, network paths,
and rarely cluster-cert SANs. Now:

- User-facing 500 body: generic
  `"internal error processing task creation; see workbench-api logs"`.
- Diagnostic detail logged via `console.error` with structured
  fields (`namespace`, `name`, `targetAgent`, `status`, `message`)
  so operators retain debugging via `kubectl logs`.

Regression test in `tasks.test.ts` asserts the 500 body never
contains `K8s API call failed` or the raw `err.message`, AND that
the structured log line still fires (using a `vi.spyOn(console, 'error')`).

**Verification:**
- `@kagent/llm-gateway` — typecheck ✓ / lint ✓ / 246 tests pass
- `@kagent/workbench-api` — typecheck ✓ / lint ✓ / 151 tests pass
  (was 150)

### Commit 2 — Theme B: info-disclosure scrubbing (L13)

`60c853a` `fix(workbench-api): scrub lastResultPreview for embedded keys (L13)`

`packages/workbench-api/src/routes/cluster.ts` — the `taskRow()`
helper previously emitted
`lastResultPreview: lastResult.slice(0, 200)` on every Active /
Recent task row served by `GET /api/cluster/snapshot`. Task
`result.content` is unconstrained agent output: a loosely-prompted
LLM can echo any token from its context window, including secrets
that travelled through a tool call, a leaked capability bundle, or
an upstream backend error body. The recommended fix in the brief
was to scrub via the same regex set as the W2-Gateway H15 fix.

Implementation:
- Imports `scrubSecrets` from `error-scrub.ts` (already present from
  M15) — keeps the regex set canonical.
- Applies `scrubSecrets(lastResult).slice(0, 200)`. Scrub THEN
  slice, so a secret split by truncation can't leak its prefix
  below the regex's 16-char floor.

Two regression tests in `cluster.test.ts`:
- `sk-proj-…` key in `result.content` is redacted to `[REDACTED]`,
  the 200-char cap is preserved post-scrub, and the row still
  surfaces a preview for triage.
- Benign content passes through unchanged — no false-positive
  redaction.

**Verification:** `@kagent/workbench-api` — typecheck ✓ / lint ✓ /
152 tests pass (was 150).

### Commit 3 — Theme C: docs (L15)

`b89a20f` `docs(gateway-contract): document X-Kagent-* headers as advisory, not authoritative (L15)`

`docs/GATEWAY-CONTRACT.md` — adds §3.1 making the advisory posture
of `X-Kagent-Task-UID`, `X-Kagent-Agent`, and `X-Kagent-Tenant`
explicit. Concretely:

- Spells out that these are **client claims**, not authentication
  primitives — anyone with a valid bearer can lie about the task /
  agent / tenant they belong to.
- Locates the authoritative auth surface squarely on
  `Authorization` (§4) and the mTLS SVID (§4.3, post-v0.4.3).
- Provides DO / DO-NOT / MAY / SHOULD guidance for both gateway
  implementers and substrate-side senders, including the explicit
  "**do not** make access-control decisions on these headers
  alone" rule.
- States the cardinality / cross-system-join intent: the contract
  optimises for cooperative-actor attribution joins (Langfuse trace
  ↔ AgentTask ↔ usage row), NOT adversarial attribution.

No code change — `parseKagentHeaders` already accepts and records
the headers as before. The commit only locks in the contract
semantics so future implementers and audit reviewers cannot mistake
advisory attribution for authoritative identity.

**Verification:** docs-only commit. All packages still pass full
checks; `@kagent/workbench-ui` build was re-run as part of the
final verification step and produced a clean dist.

## 3. Final verification sweep

Per the brief, all three packages re-checked end-to-end after the
last commit:

| Package | Typecheck | Lint | Tests | Build |
|---------|-----------|------|-------|-------|
| `@kagent/llm-gateway` | ✓ | ✓ | 246 pass | n/a |
| `@kagent/workbench-api` | ✓ | ✓ | 152 pass | n/a |
| `@kagent/workbench-ui` | ✓ | ✓ | 0 (no test files) | ✓ vite build |

`@kagent/workbench-ui` reports "No test files found, exiting with
code 0" — that matches the project's current state (UI tests not
yet authored; vitest tolerates this via `--passWithNoTests`).

## 4. Wired-but-dead-code re-scan

Scope: gateway-stream packages — `packages/llm-gateway/src/`,
`packages/workbench-api/src/`, `packages/workbench-ui/src/`.

### Step 1 — optional-call site grep

```bash
grep -rn -F '?.(' packages/llm-gateway/src \
                 packages/workbench-api/src \
                 packages/workbench-ui/src \
  | grep -v '.test.'
```

**Result: zero hits in src/.**

The few `?.(` matches present anywhere under these packages are all
inside `node_modules/` (Hono websocket adapters, Vite client
runtime), not first-party code.

### Step 2 — optional-call + `??` fallback grep

```bash
grep -rnE '\?\.\([^)]*\)\s*\?\?' packages/llm-gateway/src \
                                  packages/workbench-api/src \
                                  packages/workbench-ui/src \
  | grep -v '.test.'
```

**Result: zero hits.**

### Step 3 — classification

Nothing to classify. The W0/W2/W3 baseline of **0 net WBD findings
in gateway scope** is preserved. None of the W5-Gateway changes
introduced new optional-dep + fallback shapes:

- L12 fix uses a *required* `console.warn` call inside a closure
  with no optional dep.
- L13 fix uses a regular function import (`scrubSecrets`) — no
  optional dep, no fallback.
- L17 fix uses `console.error` (always present, not a deps-shape
  call) and a generic body.
- L15 is docs-only.

No findings to route to the arbiter.

## 5. Summary of LOW finding closures

| Finding | Status before W5-Gateway | Status after | Mechanism |
|---------|--------------------------|--------------|-----------|
| L12 | STILL OPEN | CLOSED — defence in depth from gateway side; admission-side fix delegated to W5-Operator | Discriminator-named error + observation-time warn + docs §6.2 |
| L13 | STILL OPEN | CLOSED | `scrubSecrets()` applied before slice |
| L15 | STILL OPEN | CLOSED | `GATEWAY-CONTRACT.md` §3.1 makes advisory posture explicit |
| L17 | STILL OPEN | CLOSED | Generic 500 body + structured stderr log |

## 6. Notes for future waves

- L12 has a complementary fix in W5-Operator scope: rejecting
  `ModelEndpoint.spec.backendKind: bedrock` at admission time so a
  misconfigured CR never reaches the cluster. The gateway-side fix
  is defence in depth; the operator-side is load-bearing. Both
  needed for full closure of the misconfiguration vector.
- The Bedrock SigV4 adapter itself remains a v0.2 deferred. The
  re-enable recipe is now in `docs/MODEL-ROUTING.md` §6.2 and the
  bedrock-provider.ts file header. No GitHub issue was filed in
  this wave — defer to the v0.2 milestone planning step.
- `error-scrub.ts` patterns are now used in two places
  (gateway-client projection AND cluster route preview). Future
  routes that surface arbitrary task / agent output to the UI
  should import the same module rather than reinventing a regex
  set — this is now a small enough convention that it deserves a
  brief mention in any future workbench-api route review.

## 7. File-level deliverables (absolute paths)

Modified:
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/llm-gateway/src/providers/bedrock-provider.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/llm-gateway/src/providers/provider-factory.test.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/llm-gateway/src/model-watch.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/workbench-api/src/routes/tasks.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/workbench-api/src/routes/tasks.test.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/workbench-api/src/routes/cluster.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/workbench-api/src/routes/cluster.test.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/docs/MODEL-ROUTING.md`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/docs/GATEWAY-CONTRACT.md`

Created: none.

Pushed: all three commits live on `origin/main` (`b1ac612`,
`60c853a`, `b89a20f`).
