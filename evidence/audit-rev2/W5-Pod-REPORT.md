# W5-Pod Report

**HEAD before:** `fc32b13` (per task brief)
**HEAD after:** `2c94bf2`
**Date:** 2026-05-07
**Scope:** LOW-severity items in `packages/agent-pod/**` and
`packages/agent-loop/**` from audit-rev2 C2 §1.

---

## 1. Commits landed (atomic, pushed)

| SHA | Theme | Items | Files |
|---|---|---|---|
| `70a3c31` | A — naming hygiene & tool discoverability | L1, L8, L3 | `docs/AGENT-SELF-SERVICE.md`, `packages/agent-pod/src/k8s-task-creator.ts`, `packages/agent-pod/src/artifacts.ts` |
| `5c5558c` | B — security/crypto polish | L2, L11 | `packages/agent-pod/src/cap-consumer.ts`, `packages/agent-pod/Dockerfile` |
| `5c72d79` | C-docs — observability accuracy | L10 (docs leg) | `docs/RESILIENT-CONTRACTS.md` |
| `2c94bf2` | C-code — observability accuracy | L10 (code), L14 | `packages/agent-loop/src/detectors/refusal.ts`, `packages/agent-loop/src/executor.ts` |

Theme C split into two commits because the first commit's
`git commit --only` invocation captured only the docs file —
the agent-loop src files were skipped (likely a race against
parallel-worker concurrent commits). Re-staged and re-committed
the source changes in the trailing commit. Both pushed to `main`.

All commits carry the `Co-Authored-By: Claude Opus 4.7 (1M context)`
trailer per `CLAUDE.md`.

---

## 2. Per-item summary

### L1 — substrate tool name reservation (docs)

`docs/AGENT-SELF-SERVICE.md` §11 Q1 leaned toward namespace-prefixing
built-in tools as `kagent.*`. Reverted that lean: every published
consumer (homelab-orchestrator, ai-interviewer, dynamic-specialists
demo) and every test fixture references the bare snake_case names
shipped in v0.1. Renaming would break wire compat for zero functional
gain.

Added a new §12 declaring the v0.1-shipped names RESERVED by the
substrate. The reserved list:

- `spawn_child_task`, `wait_for_child_task`, `wait_for_children_all`
- `publish_event`
- `ensure_agent_from_template`
- `get_my_context`
- `read_artifact`, `write_artifact`
- `read_blackboard`, `write_blackboard`, `list_blackboard`,
  `append_blackboard`
- `http_get`, `rss_fetch`, `extract_text`

Documented the rule for application-layer tool authors (don't
collide; runner refuses collisions per
`assertSubstrateToolsAdmitted`) and the rule for substrate
contributors (prefer `kagent_*` for new built-ins to reduce future
collision surface). Captured a `KAGENT_SUBSTRATE_TOOL_PREFIX` opt-in
as a v0.2+ design candidate, not committed.

### L8 — `createChildTask` returns `uid: ''` silently

`packages/agent-pod/src/k8s-task-creator.ts:267-271` returned
`uid: meta.uid ?? ''` on the `createNamespacedCustomObject`
response. Downstream `wait_for_child_task` polls by UID via
`getTaskByUid`, which scans for `metadata.uid === uid` — a uid of
`''` will never match any AgentTask, producing a SILENT timeout.

Replaced the silent `?? ''` with a fail-loud throw whose message
names both `namespace=<ns> name=<n>` AND the downstream consequence
("would cause silent wait_for_child_task timeouts"). The apiserver
always echoes `metadata.uid` on a 201 Created response, so a missing
uid here means a malformed body — failing loud is the correct
posture.

### L3 — bidi-override blacklist in artifact names

`packages/agent-pod/src/artifacts.ts:180-185` already refused C0/C1
control chars and DEL but accepted the Unicode bidirectional
override / formatting block (U+202A-U+202E, U+2066-U+2069). These
are the "Trojan Source" / CVE-2021-42574 surface — an artifact
rendered in the trace UI as `report.pdf` could actually be
`report.exe.pdf` with U+202E reversing the visible direction.

Extended the per-codepoint scan with two range checks; the new
error message names the blocked ranges so a curious caller
understands what was refused.

### L2 — JWKS HTTP default trust assumption documented

`packages/agent-pod/src/cap-consumer.ts:54` ships `http://` (not
`https://`) as the default JWKS URL. Kept the HTTP default — the
in-cluster trust boundary is "NetworkPolicy + ServiceAccount +
apiserver-rooted RBAC", and JWKS is a public key set by definition
(eavesdropping reveals nothing the chart doesn't already publish) —
but documented the trust assumption inline at the constant.

The new JSDoc enumerates:

1. The four conditions justifying HTTP (in-cluster only,
   NetworkPolicy gating, SA-token isolation, public-key payload).
2. The explicit migration path for tunneling JWKS off-cluster
   (override `KAGENT_CAP_JWKS_URL` with an `https://` URL).
3. The work required to flip the default to HTTPS (template-server
   TLS termination, CA bundle mount, Bun TLS parity per
   `CLAUDE.md` §Conventions).

Tracked as a v0.2 hardening item.

### L11 — slim agent-pod runtime image

`packages/agent-pod/Dockerfile` copied the entire `/repo` tree
(every package's `src/` with co-located `*.test.ts` fixtures,
vitest configs, eslint configs, scripts/, build-only tsconfigs,
any `coverage/` output) into the runtime stage. None used at
runtime — the entrypoint is plain `node dist/main.js`, resolution
flows through the existing workspace symlinks aimed at compiled
`dist/*.js` by `scripts/rewrite-exports-to-dist.mjs`.

Added a single prune step at the END of the build stage (after the
prod-only `pnpm install`) that removes:

- `src/`, `__fixtures__/`, `coverage/` (per-package)
- every dev config (vitest/eslint/tsconfig*/.tsbuildinfo)
- every `*.test.ts` / `*.test.js` (defense-in-depth)
- repo-root `scripts/` and `tsconfig.base.json`

Kept `dist/` and `package.json` per package — those plus the
pruned workspace `node_modules/` are what `node` needs at resolve
time.

**Smoke build**: `docker build -f packages/agent-pod/Dockerfile .`
succeeded end-to-end. `docker run --rm kagent-agent-pod:smoke-test`
resolved through to `/app/packages/agent-pod/dist/main.js`,
walked through `dist/env.js`'s `parseEnv`, and exited at the
expected `requireEnv("KAGENT_TASK_ID")` gate (the
pre-runtime check that fires when no env is supplied to a smoke
run). Image size: 694MB.

### L10 — refusal detector documented English-only

`packages/agent-loop/src/detectors/refusal.ts:26-48` ships an
English-only phrase set ("input is incomplete", "please provide
more details", etc.). Today's homelab pilot is English-only by
design — but the docs implied "language-aware for a known set",
which is misleading.

Added an explicit locale-assumption note to the JSDoc enumerating
the failure mode (non-English system prompts / non-English
fine-tunes will miss the phrase set silently → refusal masquerades
as success), an in-body comment warning future contributors not to
add a non-English entry without corresponding test fixtures, and a
TODO(v0.2+) for per-locale phrase sets keyed off `Agent.spec.locale`
or a detected-language heuristic.

Also patched `docs/RESILIENT-CONTRACTS.md` §detectors to point
readers at the new note instead of the old "language-aware for a
known set" claim.

### L14 — chatWithRetry per-attempt latency accuracy

`packages/agent-loop/src/executor.ts:540-551` (success path) used
`llmStart = Date.now()` AFTER `chatWithRetry` returned, which
produced a misleading "now minus a small epsilon" baseline for the
success-trace's `latency_ms` calc. Any retry that succeeded
(e.g. attempt 0 hit 429, attempt 1 succeeded) appeared to take ~0ms
in Langfuse even though it consumed real wall-clock — the
per-attempt failed-trace's latency was correct, but the success
trace's baseline was synthesized post-hoc. The previous comment
explicitly admitted "best-effort latency for the successful attempt
only".

Replaced the approximation with a precise return value.
`chatWithRetry` now tracks `attemptStart` per loop iteration:
initialized from the caller-passed `bookkeeping.llmStart` for the
first attempt, then reset alongside `bookkeeping.llmStart` after
each post-sleep retry. Both stay synchronized so the failed-attempt
trace's pre-sleep latency baseline matches what the success path
would observe if the same retry succeeded.

Augmented the return type with `successAttemptStart: number` so the
run loop's call site reads the actual winning attempt's start
timestamp instead of synthesizing one. Failure path's pre-sleep
failed-trace path unchanged — it already used the correct
per-attempt baseline.

Net effect: Langfuse / structured trace consumers now see the TRUE
time-to-response for each LLM round-trip, including the winning
attempt after a retry ladder. No behavior change for attempt-0
success (the new return value equals the existing `llmStart`).

---

## 3. Verification

### Per-package gates

```
$ cd packages/agent-loop
$ npm run typecheck       # PASS
$ npm run lint            # PASS
$ npm test                # PASS — 12 files, 177 tests

$ cd packages/agent-pod
$ npm run typecheck       # PASS
$ npm run lint            # PASS
$ npm test                # PASS — 17 files, 530 tests
```

### Docker smoke (L11)

```
$ docker build -f packages/agent-pod/Dockerfile -t kagent-agent-pod:smoke-test .
... DONE 6.7s

$ docker run --rm kagent-agent-pod:smoke-test
[kagent-agent-pod] fatal: Error: required env var KAGENT_TASK_ID is missing or empty
    at requireEnv (file:///app/packages/agent-pod/dist/env.js:318:15)
    at parseEnv (file:///app/packages/agent-pod/dist/env.js:71:20)
    at main (file:///app/packages/agent-pod/dist/main.js:114:20)
```

`requireEnv` firing at the expected pre-runtime gate confirms
node successfully resolved `dist/main.js`, walked through
`dist/env.js`, and reached the runtime config validation step.
The slim image boots correctly.

---

## 4. Wired-but-dead-code (WBD) scan — agent-pod / agent-loop

Per `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md` §"Detection".

### Step 1 — optional-call sites

Pattern: `<obj>?.(...)` in package src (excluding `*.test.ts`):

```
packages/agent-pod/src/builtin-tools-spawn.ts:364
  deps.remainingBudgetSeconds?.()
packages/agent-pod/src/builtin-tools-spawn.ts:385
  deps.getTraceparent?.()
packages/agent-pod/src/builtin-tools-wait.ts:124
  deps.remainingBudgetSeconds?.()
packages/agent-pod/src/builtin-tools-wait.ts:207
  deps.remainingBudgetSeconds?.()
packages/agent-pod/src/builtin-tools.ts:1132
  deps.remainingBudgetSeconds?.()
packages/agent-pod/src/builtin-tools.ts:1153
  deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }
packages/agent-loop/src/**: 0 hits
```

### Step 2 — classification per WBD/MCALL/CSPREAD/DEADBRANCH

| Site | Classification | Notes |
|---|---|---|
| `builtin-tools-spawn.ts:364` `deps.remainingBudgetSeconds?.()` | **CSPREAD** | Prior W0-Pod / W2-Pod / W3-Pod confirmed. Production wireup: `main.ts:441` does `...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds })`. The dep is genuinely absent when `runConfig.timeoutSeconds` is unset (legacy task with no per-task budget). The fallback (no budget propagation) is correct. |
| `builtin-tools-spawn.ts:385` `deps.getTraceparent?.()` | **CSPREAD** | Prior W0-Pod confirmed. Production: `main.ts:442` `...(getTraceparent !== undefined && { getTraceparent })`. Genuinely absent when OTel is disabled — correct fallback (skip header injection). |
| `builtin-tools-wait.ts:124` `deps.remainingBudgetSeconds?.()` | **CSPREAD** | Same as `spawn.ts:364`. Wireup: `main.ts:449`. |
| `builtin-tools-wait.ts:207` `deps.remainingBudgetSeconds?.()` | **CSPREAD** | Same as `spawn.ts:364`. Wireup: `main.ts:454`. |
| `builtin-tools.ts:1132` `deps.remainingBudgetSeconds?.()` | **CSPREAD** | `defineGetMyContext`. Wireup: `main.ts:667` (in spawn block) AND through `RunDeps` for the universal-context provider per the audit-rev2 NM5 fix. |
| `builtin-tools.ts:1153` `deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }` | **CSPREAD (post-NM5 fix)** | Was the original NB1 wired-but-dead site. Production wireup confirmed via `main.ts:358 buildTokenUtilizationBridge → main.ts:666 RunDeps → runner.ts → resolveToolProviders universal-context provider → defineGetMyContext deps`. The fallback fires only on the test-injection seam. The W3-Pod report classified this as CSPREAD post-fix and that classification holds at `2c94bf2`. |

### Step 3 — confirmed wired-but-dead sites

**Zero new wired-but-dead findings in agent-pod / agent-loop scope at HEAD `2c94bf2`.**

All optional-call sites are CSPREAD-class (legitimate feature flags
or test-injection seams) with production wireup confirmed in
`packages/agent-pod/src/main.ts` and `runner.ts`. The original NB1
site (`tokenUtilizationSnapshot`) remains repaired since the W3
audit wave; this report did NOT introduce any new optional-shaped
deps with fallback values.

No high-risk shapes found:

- No new telemetry/trace/metric sinks added in this wave.
- No new audit emitters added.
- No new capability checks with `?? GRANT` defaults.
- No new backoff/retry policy callbacks introduced.

---

## 5. Out of scope (per task brief)

- Operator-scope LOWs (L4, L5, L6, L7) — handled by W5-Operator.
- Gateway-scope LOWs (L12, L13, L15, L17) — handled by W5-Gateway.
- Final wired-but-dead arbiter scan — separate task.

---

## 6. Files touched (absolute paths)

- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/docs/AGENT-SELF-SERVICE.md`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/docs/RESILIENT-CONTRACTS.md`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-pod/src/k8s-task-creator.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-pod/src/artifacts.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-pod/src/cap-consumer.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-pod/Dockerfile`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-loop/src/detectors/refusal.ts`
- `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/packages/agent-loop/src/executor.ts`
