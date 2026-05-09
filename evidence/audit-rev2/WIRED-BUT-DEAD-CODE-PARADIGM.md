# Wired-but-Dead-Code — anti-pattern detection guide

**Surfaced by:** rev2 audit finding NB1 (`packages/agent-pod/src/main.ts:359-363` — `tokenUtilizationSnapshot` declared optional in `defineGetMyContext`'s deps shape, injected by tests, omitted by the production wireup; the LLM always reads `{used: 0, modelWindow: null, percentage: null}` despite the v0.1.9 slate's marquee feature being "agent-managed context handling via `get_my_context.tokenUtilization`").

**Why it deserves its own paradigm name:** the failure mode is invisible from outside the production process. CI is green. Code review approves. The feature appears to ship. The codepath is functionally inert.

---

## The signature

A wired-but-dead-code site has all four of:

1. **Optional-shaped dep** — function declares a dependency via destructured options with `?` modifier:
   ```ts
   function defineFoo(deps: { snapshot?: () => Snapshot, ... })
   ```
2. **Optional-chained call with fallback** — function body uses `?.()` and `??`:
   ```ts
   const snapshot = deps.snapshot?.() ?? { used: 0, modelWindow: null };
   ```
3. **Tests inject the dep directly** — unit tests construct the function with the dep present:
   ```ts
   defineFoo({ snapshot: () => ({ used: 100, modelWindow: 8000 }), ... })
   ```
4. **Production callsite omits the dep** — the boot path / wire-up file constructs the function WITHOUT the dep, relying on the fallback:
   ```ts
   defineFoo({ podConfig, capabilityBundle }) // snapshot field absent
   ```

**Smoking gun:** the production fallback fires unconditionally; tests pass; feature is dead.

---

## Why it happens

This pattern is born from "test-first" hygiene done halfway:

- The dep is shaped optional to make tests easy (tests don't always need real `RunBudget` plumbing).
- The fallback is a "sensible default" that lets unit tests work without the dep.
- The wire-up file is written separately, often after the unit, and the wire-up author doesn't realize the dep is required for production behavior.
- Tests for the wire-up file are absent (because "the unit is tested already"), so coverage doesn't catch the gap.
- Code review sees the fallback and assumes "it gracefully degrades."

---

## Detection — every team must run this scan in their scope

### Step 1 — list all optional-call sites in your package scope

```bash
# Match `deps.<name>?.(` and `<obj>.<name>?.(` patterns
grep -nE '\w+\.\w+\?\.\(' packages/<your-pkg>/src/**/*.ts | grep -v '\.test\.ts'

# Match `?? { ` and `?? \[\]` style fallbacks following an optional call
grep -nE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/<your-pkg>/src/**/*.ts
```

### Step 2 — for each hit, classify

For every optional-call site:

| Question | Answer |
|---|---|
| Is the dep declared in a `deps`-style options object with `?`? | If no, this is just a normal nullable check — skip. |
| Is the production wire-up site passing the dep? | If yes — wired correctly. If no — **wired-but-dead.** |
| Does the test inject the dep? | If yes AND production omits it — confirmed wired-but-dead. |
| What value does the fallback collapse to? | Document it. If the fallback "looks reasonable" (e.g. `{used: 0}`), the bug is HIDDEN. |

### Step 3 — file:line reports

For each confirmed wired-but-dead site, report:

```
- finding: <one sentence>
- declaration: <file:line of the optional-shaped dep>
- production callsite: <file:line where the dep is omitted>
- test callsite: <file:line where the dep is injected (for contrast)>
- fallback value: <the literal value the LLM/caller actually observes>
- impact: <what feature is silently dead>
```

---

## Fix shape

Every wired-but-dead fix should:

1. **Wire the dep at the production callsite.** The fix is usually a 3–10 line closure or thunk over an already-existing mutable ref or function the boot path has access to.
2. **Keep the optional shape if tests need it** — but consider a *required* constructor variant for production wire-up, so the type system catches the omission next time:
   ```ts
   // unit-level (optional, for tests)
   function defineFoo(deps: { snapshot?: () => Snapshot })

   // boot-level (required, for production)
   function buildFooForProduction(deps: { snapshot: () => Snapshot }): Foo
   ```
3. **Add a regression test that drives the full production wireup**, not the unit-with-deps shape. The test must observe a non-fallback value.
4. **In the audit log / commit message**, name the wired-but-dead-code paradigm explicitly so future readers can search for it.

---

## Common high-risk shapes in kagent

These shapes have a high prior probability of harboring wired-but-dead-code instances:

- **Telemetry / trace / metric sinks** — easy to ship optional, easy to forget to wire
- **Snapshot / introspection callbacks** — by nature read-only, no test failure if dead
- **Audit emitters** — failure to emit looks like quiet success (confirmed: WBD-OP-1 `auditEmit` in `agent-workflow-controller.ts:146` — `workflow.started` / `event_subscription_pending` events silently no-op because `main.ts:2485-2496` doesn't pass the dep)
- **Capability checks** with `?? GRANT` defaults — INVERTS the security posture; treat as critical
- **Backoff / retry policy callbacks** with `?? simpleStrategy` defaults
- **Snapshot-time vs call-time observability** — `?.snapshot()` patterns where the snapshot is meant to be live (confirmed: NB1 `tokenUtilizationSnapshot`)

If you find an optional-call site in any of these shapes, scrutinize harder.

---

## Sibling patterns that LOOK like wired-but-dead but aren't (don't false-positive)

These shapes share the spirit ("test passes, production-dead") but are NOT the wired-but-dead-code paradigm. Classify accurately or you'll double-count:

### Sibling 1: Missing-call on a required dep (e.g. H18)

**Surfaced by:** W0-Gateway report. H18 (`apiKeyRepo.touchLastUsed` never called from production auth path) is structurally similar but distinct:

- The dep is NOT optional — `apiKeyRepo: ApiKeyRepo` (no `?:`) at `server.ts:61`
- The production wire-up DOES pass the dep — `main.ts:64,100` constructs and threads `apiKeyRepo`
- Tests DO inject the dep
- BUT: the production callsite that should call `touchLastUsed` simply never invokes it — the method exists on the dep, the dep is wired, the call is just missing

**Why it's different:** there is no `?.()` operator, no `??` fallback to a sensible-looking default. It's a regular "missing call" bug. Fix: call the method.

The wired-but-dead-code paradigm specifically requires the optional-fallback shape because that's what makes the bug HIDDEN — the fallback collapses to a value that looks reasonable, and there's no compile error or test failure when the dep is omitted from the production wireup.

### Sibling 2: Conditional spread on legitimately-optional features

**Surfaced by:** W0-Pod report. Five hits in `builtin-tools-spawn.ts`, `builtin-tools-wait.ts`, and `builtin-tools.ts` are NOT wired-but-dead:

```ts
// runner.ts production wireup:
defineSpawnChildTask({
  ...(env.OTEL_ENABLED && { getTraceparent: () => readTraceparent() }),
  ...(runConfig.timeoutSeconds !== undefined && { remainingBudgetSeconds: () => ... }),
})
```

The conditional spread is the production answer to "feature is enabled" vs "feature is off." When OTel is off, `getTraceparent` is genuinely absent and the optional fallback (skip header injection) is the correct behavior. When per-task timeout is unset, `remainingBudgetSeconds` is genuinely absent and the fallback (no budget propagation) is correct.

**Why it's different:** the feature being off IS the production state for some configurations. The dep is wired CONDITIONALLY based on upstream input — not omitted by oversight.

**Heuristic:** look at the production callsite. If it uses `...(condition && { dep })` and the condition is observable upstream config, you have a feature flag, not a wired-but-dead site. Document the condition in comments near both ends so future readers can verify the wiring matches.

### Sibling 3: Dead-branch comment blocks (e.g. WBD-OP-2 / M2)

**Surfaced by:** W0-Operator report. `supervision-router.ts:412-418` has:

```ts
if (deps.listChildrenForParent !== undefined) {
  // Comment explaining why this branch can't actually use the dep here
  // (siblings-by-parent-UID reader can't return the parent itself)
}
// falls through to unbounded LIST regardless
```

The dep IS wired in production. The branch IS reachable. But the branch body is empty (just a comment), so the optimization the dep was meant to enable is unrealized.

**Why it's different:** wired-but-dead-code is "the dep is missing"; dead-branch comment blocks are "the dep is present but the optimization wasn't built." Different fix: implement the optimization or delete the branch.

### How to file the classification

When reporting scan findings, prefer this taxonomy:

- **WBD (wired-but-dead-code)** — the paradigm proper. Optional dep + fallback + production omits.
- **MCALL (missing call)** — required dep wired, but a callsite is missing. Sibling 1.
- **CSPREAD (conditional spread)** — legitimate feature flag via `...(condition && { dep })`. Not a bug.
- **DEADBRANCH** — dep wired, branch reachable, branch body unrealized. Sibling 3.

Only WBD entries route to the arbiter as fix candidates. MCALL entries route to the original audit's HIGH/MEDIUM queue (e.g. H18). CSPREAD entries deserve a comment if the condition is non-obvious. DEADBRANCH entries route to perf/refactor queue.

---

## Discipline for every team

After every fix wave, before reporting "done":

- [ ] Run the Step 1 grep in your scope
- [ ] Classify each hit per Step 2
- [ ] Report file:line list of any confirmed wired-but-dead sites — do NOT fix in this wave; the arbiter will queue them as new tasks
- [ ] If you find a HIGH-shape wired-but-dead site (capability check, security guardrail), flag it as BLOCKER-shape regardless of severity in the original audit

The arbiter is responsible for converting reports into new tasks, not the team. Just report.

---

## Summary heuristic

**"If the test injects it and production doesn't, the feature is dead."**

When you write or review a function with optional deps and a fallback, ask: does the production wire-up pass this dep? If you can't answer in 30 seconds, find out.
