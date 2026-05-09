# Final Wired-but-Dead-Code Arbiter Scan

**Audit:** rev2 — paradigm closure verification
**Date:** 2026-05-07
**HEAD:** `2c94bf2` (post-W5)
**Scope:** all 26 packages under `packages/*/src/**/*.ts` (excluding `*.test.ts`)
**Reference:** `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md` (taxonomy: WBD / MCALL / CSPREAD / DEADBRANCH)
**Per-team aggregator inputs:** W0-Pod, W0-Operator, W0-Gateway, W1-Operator, W1-Pod, W1-Strategy, W2-Pod, W2-Operator, W2-Gateway, W3-Pod, W3-Operator, W3-Gateway, W3-Followups, W4-Vercel-Ai, W5-Pod, W5-Operator, W5-Gateway

---

## 1. Executive summary

**Verdict: WBD-CLEAN at HEAD.**

| Class | NEW (introduced W0–W5) | SURVIVING from rev2 | RESOLVED in W0–W5 | Remaining at HEAD |
|---|---|---|---|---|
| **WBD** (wired-but-dead-code, paradigm proper) | 0 | 0 | 2 (NB1, WBD-OP-1) | **0** |
| **MCALL** (missing call on required dep) | 0 | 0 | 1 (H18) | **0** |
| **DEADBRANCH** (dep wired, branch unrealized) | 0 | 0 | 1 (WBD-OP-2 / M2) | **0** |
| **CSPREAD** (legitimate feature flag) | ~389 (inventory only) | n/a | n/a | ~389 |

The substrate is at **net-zero WBD** as of `2c94bf2`. The four originally-flagged
sites (NB1 `tokenUtilizationSnapshot`, WBD-OP-1 `auditEmit`, WBD-OP-2 / M2
`listChildrenForParent`, H18 `touchLastUsed` MCALL-sibling) are all closed
with verifiable production wireups + regression tests. The new
`agent-loop-vercel-ai` package (W4) does NOT introduce any WBD sites — its
optional-shaped surface (capability bundle, capability bindings, context
window) is uniformly CSPREAD-class with documented feature-flag conditions
and fail-CLOSED defaults at security-sensitive boundaries.

**Paradigm hardening:** the 5-wave fixes have transitioned the substrate
from "the paradigm exists and is exploitable" (rev2) to "the paradigm is
named, scanned-for in every wave, and the four discovered instances are
closed" (HEAD). All optional-call sites in production scope at HEAD have
been classified by per-team scans; the inventory below is the consolidated
view across teams.

---

## 2. Per-package tally

Counts derived from canonical scan: `grep -rnE 'deps\.\w+\?\.\(' src` and
the broader `X.Y?.()` / `?.() ?? {/[` predicates.

| Package | `?.()` sites | WBD | MCALL | CSPREAD/handler/test-seam | Notes |
|---|---|---|---|---|---|
| `agent-loop` | 0 | 0 | 0 | 0 | No optional-call sites in production code paths. |
| `agent-loop-vercel-ai` (NEW W4) | 0 | 0 | 0 | 0 | All optional-shaped deps use CSPREAD spread at the wireup (`runner.ts:125-152`). The capability wrapper has a fail-CLOSED default (`requireBundle ?? true`). The trace bridge always populates the in-memory `traces` array (no silent drop). |
| `agent-pod` | 6 | 0 | 0 | 6 | 5 × `remainingBudgetSeconds`, 1 × `getTraceparent` — all CSPREAD (W3-Pod / W5-Pod confirmed). The 6th hit (`builtin-tools.ts:1153 tokenUtilizationSnapshot`) was the original NB1 site; production wireup now threads it through `buildTokenUtilizationBridge → RunDeps → resolveToolProviders → defineGetMyContext`. CSPREAD post-fix. |
| `agent-workflow-runtime` | 0 | 0 | 0 | 0 | — |
| `audit-events` | 0 | 0 | 0 | 0 | — |
| `blackboard` | 0 | 0 | 0 | 0 | — |
| `cache-controller` | 0 | 0 | 0 | 0 | — |
| `capability-types` | 0 | 0 | 0 | 0 | — |
| `cli` | 1 | 0 | 0 | 1 | `commands/submit.ts:149 opts.onPhaseChange?.()` — UI progress callback; absence is correct in non-interactive mode. CSPREAD. |
| `dto` | 0 | 0 | 0 | 0 | Pure type definitions. |
| `egress-controller` | 0 | 0 | 0 | 0 | — |
| `events` | 0 | 0 | 0 | 0 | — |
| `http-tool-provider` | 0 | 0 | 0 | 0 | — |
| `in-process-tool-provider` | 0 | 0 | 0 | 0 | — |
| `keyrotation-controller` | 2 | 0 | 0 | 2 | `gateway-rotation.ts:221,228 timer.unref?.()` — Node.js timer optional API (older runtimes). Not the WBD shape. |
| `llm-gateway` | 0 | 0 | 0 | 0 | H18 (MCALL) closed at `392b5bd`. No remaining optional-call sites. |
| `locality-controller` | 0 | 0 | 0 | 0 | — |
| `mcp-tool-provider` | 0 | 0 | 0 | 0 | — |
| `openai-compat` | 0 | 0 | 0 | 0 | — |
| `operator` | 38 | 0 | 0 | 38 | See breakdown below. |
| `quota-controller` | 0 | 0 | 0 | 0 | — |
| `supervision` | 0 | 0 | 0 | 0 | — |
| `trace-sinks` | 0 | 0 | 0 | 0 | — |
| `triggers` | 0 | 0 | 0 | 0 | — |
| `versioning-controller` | 0 | 0 | 0 | 0 | — |
| `workbench-api` | 0 | 0 | 0 | 0 | — |
| `workbench-ui` | 0 | 0 | 0 | 0 | Out of scope (presentational); also no optional-call sites. |
| **Total** | **47** | **0** | **0** | **47** | |

### Operator scope — 38 hits broken out

- **Watch / job-watch error handlers** (15 sites): `watch.ts:112-164` and
  `job-watch.ts:133-200` — `handler.onError?.(err)` and `handler.onJob /
  onPod` follow-up. Handler-shape (caller may opt out of error notification);
  not the WBD shape. Production wireup at `main.ts` always passes
  `onError`. CSPREAD-equivalent (handler-injection seam).
- **Workspace controller cache injection** (4 sites): `workspace-controller.ts:460,465,481,491`
  `input.lookupPvc?.()` / `input.lookupCloneJob?.()`. Production wireup at
  `workspace-controller.ts:825` always passes both; the optional shape is
  for unit tests that don't need a cache. CSPREAD/test-seam.
- **AgentWorkflow controller cache injection** (1 site): `agent-workflow-controller.ts:495`
  `input.lookupDeployment?.()`. Production wireup at `agent-workflow-controller.ts:1015`
  always passes it. CSPREAD/test-seam.
- **AgentWorkflow controller `auditEmit`** (2 sites): `agent-workflow-controller.ts:517,519`
  — was WBD-OP-1. Now wired at `main.ts:2946` (`workflowAuditHolder.emit?.(...)`).
  See §6 verification.
- **Audit fan-out holder pattern** (4 sites): `main.ts:1940,1943,1946,2946`
  `capabilityAuditHolder.emit*?` / `parentChildrenAggregatedAuditHolder.emit?` /
  `workflowAuditHolder.emit?`. The closures threaded into `ReconcileDeps`
  ALWAYS fire; the holder fields are populated at `main.ts:2264-2438` once
  the audit publisher init completes. The `?.()` is the inner call from
  the always-passed closure to the late-bound holder field. This is the
  W1-Operator-classified "audit-best-effort pattern" — CSPREAD-equivalent.
- **Reconcile audit emissions** (2 sites): `reconcile.ts:715,725` `deps.emitCapabilityMinted?.()` /
  `deps.emitKeyrotationCapMintedWithTtl?.()`. Production wireup at
  `main.ts:1939-1944` always passes these closures. CSPREAD-equivalent.
- **Reconcile tenant resolver** (1 site): `reconcile.ts:670 deps.resolveTenantForTask?.()`.
  Production wireup at `main.ts:1938` always passes it. CSPREAD/test-seam.
- **Triggers webhook secret resolver** (1 site): `triggers-bootstrap.ts:183 deps.resolveTriggerSecret?.()`.
  Production wireup at `main.ts:2677` always passes it. CSPREAD/test-seam.
- **Informer-restart logger hook** (1 site): `informer-restart.ts:166 logger.onCapReached?.()`.
  Operator-side telemetry hook; production wires it. CSPREAD/test-seam.
- **CAS-GC clock injection** (1 site): `cas-gc.ts:263 deps.now?.() ?? Date.now()`.
  Test-seam clock injection; the production fallback `Date.now()` is the
  desired behavior. CSPREAD/clock-injection (W5-Operator confirmed).
- **Node.js timer `.unref()` API** (3 sites): `main.ts:3081,3403,3926
  X.unref?.()`. Not the WBD shape — guarding against pre-Node-22 runtimes.
- **Comment block (false positive)** (2 lines): `main.ts:2425,2426` —
  text inside a comment, not a callsite.

---

## 3. Confirmed WBD sites at HEAD

**None.** Zero confirmed wired-but-dead-code sites at `2c94bf2`.

---

## 4. Confirmed MCALL sites at HEAD

**None.** Zero missing-call sibling sites at `2c94bf2`.

H18 (`apiKeyRepo.touchLastUsed` not called from production auth path) was
the only MCALL ever flagged. It was closed at commit `392b5bd`
(`fix(llm-gateway): call apiKeyRepo.touchLastUsed after authenticate`),
verified at `packages/llm-gateway/src/server.ts:321`:

```ts
void deps.apiKeyRepo.touchLastUsed(auth.keyHash).catch((err: unknown) => {
  console.error('[llm-gateway] touchLastUsed failed:', err);
});
```

Regression test at `packages/llm-gateway/src/server.test.ts:441-485`
asserts both the positive path (touched on success) and the negative path
(NOT touched on auth failure). MCALL closed.

---

## 5. CSPREAD inventory

Conditional-spread feature-flag sites (NOT bugs — production answer to
"feature is enabled" vs "feature is off"):

| Package | CSPREAD count |
|---|---|
| `operator` | 139 |
| `agent-pod` | 75 |
| `workbench-api` | 66 |
| `dto` | 26 |
| `cli` | 16 |
| `agent-loop-vercel-ai` | 16 |
| `agent-loop` | 15 |
| `llm-gateway` | 12 |
| `egress-controller` | 7 |
| `keyrotation-controller` | 4 |
| `capability-types` | 3 |
| `mcp-tool-provider` | 2 |
| `triggers` | 2 |
| `events` | 1 |
| `http-tool-provider` | 1 |
| `in-process-tool-provider` | 1 |
| `locality-controller` | 1 |
| `quota-controller` | 1 |
| `versioning-controller` | 1 |
| **Total** | **389** |

(Counted via `grep -rnE '\.\.\.\([^)]+\s+&&\s+\{' src --include='*.ts' --exclude='*.test.ts'`.)

The substrate uses CSPREAD intentionally and pervasively — the operator's
139 sites cover OTel toggles, Kata vs runc class, capability mint
envelope, supervision policy presence, locality affinity derivation, and
the per-modelClass `contextWindowTokens` plumbing introduced in this
release. Each CSPREAD requires the same discipline as any feature flag
(document the condition near the wireup), but they are NOT WBD candidates.
The 5-wave reports applied this discipline consistently; W3-Followups
specifically called out the new `mtlsIdentityResolver` CSPREAD site
introduced for v0.4.3+ and pre-documented it for the eventual mTLS-front
substrate.

---

## 6. Resolved sites — verification at HEAD

### NB1 — `tokenUtilizationSnapshot`

**Status: CLOSED.** Commit `78975df`
(`fix(agent-pod): wire tokenUtilizationSnapshot to live RunBudget for get_my_context (NB1)`).

Verification chain at HEAD:

1. `packages/agent-pod/src/main.ts:358` — `buildTokenUtilizationBridge(...)`
   constructs the live-budget thunk.
2. `packages/agent-pod/src/main.ts:666` — `RunDeps.tokenUtilizationSnapshot`
   passes the thunk into `runAgentTask`.
3. `packages/agent-pod/src/runner.ts:767-768` — `resolveToolProviders`
   forwards the dep into `defineGetMyContext`'s deps via CSPREAD spread.
4. `packages/agent-pod/src/builtin-tools.ts:1153` — the optional-call
   `deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }`
   now resolves to the live-budget value in production. The fallback
   fires only on the test-injection seam.

### WBD-OP-1 — `auditEmit` (AgentWorkflow controller)

**Status: CLOSED.** Commit `60e278f`
(`fix(operator): wire auditEmit to AgentWorkflow controller from main (WBD-OP-1, task #29)`).

Verification chain at HEAD:

1. `packages/operator/src/main.ts:1918-1919` — `workflowAuditHolder` mutable
   holder declared.
2. `packages/operator/src/main.ts:2438` — holder field populated by
   audit-publisher init: `workflowAuditHolder.emit = (type, payload): void => {...}`.
3. `packages/operator/src/main.ts:2941-2946` — `auditEmit` closure passed
   into `buildAgentWorkflowController`:
   ```ts
   auditEmit: (type, payload) => {
     workflowAuditHolder.emit?.(type, payload);
   },
   ```
4. `packages/operator/src/agent-workflow-controller.ts:517,519` — the
   optional-call sites that previously no-op'd now fire through the
   closure to the publisher (or no-op gracefully when NATS is absent).

### WBD-OP-2 / M2 — `listChildrenForParent` deadbranch

**Status: CLOSED.** Commit `51e5152`
(`fix(operator): use informer-cache lookup for supervision parent/uid resolution (M2)`).

Verification chain at HEAD:

1. `packages/operator/src/main.ts:1661` — `listChildrenForParent` defined
   reading the informer cache.
2. `packages/operator/src/main.ts:1927,1979` — passed both into
   `ReconcileDeps` AND `SupervisionRouterDeps`.
3. `packages/operator/src/supervision-router.ts:528-529` — the previously-empty
   branch body now performs the actual sibling lookup via the dep:
   ```ts
   if (deps.listChildrenForParent === undefined) return [];
   return deps.listChildrenForParent(parentUid, namespace).map(taskToSibling);
   ```
   The DEADBRANCH (empty body returning `undefined` to fall through to
   unbounded LIST) is replaced by a real lookup.

### H18 — `touchLastUsed` MCALL sibling

**Status: CLOSED.** Commit `392b5bd`. Verified §4 above.

---

## 7. Discipline recommendations for v0.2 onward

To prevent the WBD anti-pattern from recurring:

### 7.1 Per-package CI guard

Add an opt-in `bun run check:wbd` script per package whose script invokes
the canonical scan and writes a CSPREAD/WBD inventory to a generated
artifact. New optional-shaped deps require an entry in a
`docs/CSPREAD-INVENTORY.md` (per package) explaining the condition for
the dep being absent in production. CI fails if a `?.() ?? {literal}`
shape appears in source without a matching entry.

Suggested initial scan command (already battle-tested by W0-W5):

```bash
grep -rnE 'deps\.\w+\?\.\(' packages/<pkg>/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/<pkg>/src --include='*.ts' --exclude='*.test.ts'
```

### 7.2 New-package template

When `pnpm create @kagent/package` (or equivalent) bootstraps a new
package, the template should include:

- A `WBD-NOTES.md` stub committed alongside `README.md` that declares
  "this package's optional-shaped deps and the production wireup that
  populates them."
- A `vitest` example test that exercises the FULL boot path (not just
  the unit-level constructor) with no mock-deps injection.
- A header comment in any new file that introduces an optional-call
  site, citing `WIRED-BUT-DEAD-CODE-PARADIGM.md` and naming the
  condition under which the dep is absent.

### 7.3 Code-review checklist

Add to the kagent code-review template:

- [ ] Any new `<x>?: <fn>` in a deps interface — does the production
      wireup pass it? Confirmed by reading the boot path, not just the
      tests.
- [ ] Any new `?.() ?? {literal}` — does the literal "look reasonable"?
      If yes, this is the HIDDEN bug shape; require the production
      wireup to pass the dep unconditionally.
- [ ] If the dep is genuinely optional (CSPREAD): does the production
      wireup use the `...(condition && { dep })` shape with the
      condition derived from observable upstream config? If yes,
      document the condition near both the optional declaration and
      the wireup site.

### 7.4 Required-shape constructor for production wireup

For deps declared optional-for-tests but required-for-production, prefer
the dual-constructor pattern:

```ts
// unit-level (tests)
function defineFoo(deps: { snapshot?: () => Snapshot })

// boot-level (production)
function buildFooForProduction(deps: { snapshot: () => Snapshot }): Foo
```

The type system catches the omission at the boot site. The substrate
already follows this in `@kagent/agent-pod`'s `runAgentTask` — extend
to other packages opportunistically.

### 7.5 Holder pattern documentation

The operator's audit-fan-out holder pattern (`capabilityAuditHolder` /
`workflowAuditHolder` / `parentChildrenAggregatedAuditHolder` /
`supervisionAuditHolder`) is a legitimate response to startup-ordering
constraints between the audit publisher and the controllers. New holder
sites should:

- Cite the existing holders in their declaration comments (so future
  scanners recognize the pattern).
- Have a regression test that asserts the holder field is populated by
  boot completion (not just exercises the inner `?.()` no-op path).

---

## 8. Out of scope

- **Test files** (`*.test.ts`) — by definition exercise the optional
  shape; the WBD signature requires `tests inject + production omits`.
- **`packages/workbench-ui/`** — presentational React components. Some
  optional callbacks (e.g. `onClick?` in JSX) are normal React API
  surface, not the deps-injection pattern.
- **Type declarations only** (`*.d.ts`, `dto`, `capability-types`) —
  type shape, no production wireup distinction.
- **Markdown / docs** — `main.ts:2425-2426` were comment-block lines
  matched by the broad scan; these are documentation of the closed
  WBD-OP-1 site, not callsites.
- **Generated code** (`coverage/`, `node_modules/`, `.tsbuildinfo`,
  `dist/`) — excluded from scan via `--include='*.ts'` and the
  `src/` scope.

---

## 9. Appendix — full HEAD scan output

Canonical scan: `deps.<x>?.(` predicate.

```
packages/agent-pod/src/builtin-tools-spawn.ts:364:      const remaining = deps.remainingBudgetSeconds?.();
packages/agent-pod/src/builtin-tools-spawn.ts:385:      const traceparent = deps.getTraceparent?.();
packages/agent-pod/src/builtin-tools-wait.ts:124:        deps.remainingBudgetSeconds?.(),
packages/agent-pod/src/builtin-tools-wait.ts:207:        deps.remainingBudgetSeconds?.(),
packages/agent-pod/src/builtin-tools.ts:1132:      const secondsRemaining = deps.remainingBudgetSeconds?.();
packages/agent-pod/src/builtin-tools.ts:1153:      const snapshot = deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null };
packages/operator/src/triggers-bootstrap.ts:183:        const secret = deps.resolveTriggerSecret?.(id);
packages/operator/src/reconcile.ts:670:    const tenant = deps.resolveTenantForTask?.(task, agent);
packages/operator/src/reconcile.ts:715:    await deps.emitCapabilityMinted?.({ ... });
packages/operator/src/reconcile.ts:725:      await deps.emitKeyrotationCapMintedWithTtl?.({ ... });
packages/operator/src/main.ts:2425:    // (`agent-workflow-controller.ts:517,519`) calls `deps.auditEmit?.('started', ...)`  [comment]
packages/operator/src/main.ts:2426:    // and `deps.auditEmit?.('event_subscription_pending', ...)` but the           [comment]
packages/operator/src/cas-gc.ts:263:  const now = deps.now?.() ?? Date.now();
packages/operator/src/agent-workflow-controller.ts:517:  if (createdDeployment) deps.auditEmit?.('started', { workflow: wf.metadata.name ?? '' });
packages/operator/src/agent-workflow-controller.ts:519:    deps.auditEmit?.('event_subscription_pending', { ... });
```

Canonical scan: `?.(...) ?? {/[` predicate (the smoking-gun shape).

```
packages/agent-pod/src/builtin-tools.ts:1153:      const snapshot = deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null };
```

Single hit, classified as CSPREAD post-NB1-fix (production threading
verified §6 above).

---

## 10. Closing note

The wired-but-dead-code paradigm has been:

1. **Named** in `WIRED-BUT-DEAD-CODE-PARADIGM.md` with a four-class
   taxonomy (WBD / MCALL / CSPREAD / DEADBRANCH).
2. **Scanned** by every team in every wave (W0–W5), with results
   reported in `evidence/audit-rev2/W*-REPORT.md`.
3. **Closed** at HEAD across all four originally-flagged instances
   (NB1, WBD-OP-1, WBD-OP-2, H18).
4. **Inventoried** for legitimate CSPREAD adjacent uses (~389 sites)
   so future scanners can distinguish bug from feature.

The arbiter's punchlist for this paradigm axis is closed. No follow-up
fix tasks are queued from this scan.

---

**Co-Authored-By:** Claude Opus 4.7 (1M context) <noreply@anthropic.com>
