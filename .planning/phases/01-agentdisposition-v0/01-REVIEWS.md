---
phase: 1
reviewers: [codex, gemini, opencode]
skipped: [claude (running inside Claude Code; self-skip per workflow)]
reviewed_at: 2026-05-09T18:12:41Z
plans_reviewed: [01-01-PLAN.md, 01-02-PLAN.md, 01-03-PLAN.md, 01-04-PLAN.md]
---

# Cross-AI Plan Review — Phase 1: AgentDisposition prototype (overlay-first, no CRD)

## Codex Review (gpt-5.5, xhigh reasoning)

## Summary

The plans are generally strong and mostly aligned with the re-steering: ConfigMap overlay, no new CRD/reconciler/webhook, narrowing in the existing cap-issuer path, computed Workbench projection, and Command Center source-binding are the right architecture. The main risks are semantic correctness around “proposal” counting/enforcement, D7 source-binding completeness, missing workbench-api RBAC for ConfigMap reads, and a few places where the plan claims exactly-once or fail-closed behavior that the implementation sketch does not actually guarantee.

## Strengths

- ConfigMap carrier is the right primary choice: GitOps-friendly, `kubectl get` inspectable, structured enough for nested fields, and not a new CRD.
- The plan correctly avoids admission webhooks and puts DISP-02 enforcement in the existing capability-JWT mint path.
- `PROPOSAL_TOOL_MAP` makes the missing proposal/action mapping explicit instead of burying it in string checks.
- Shared parser/DTO intent is good: operator and workbench-api should not independently interpret disposition YAML.
- Validation coverage is broad: schema, authority narrowing, counter projection, over-budget emission, UI reload stability, and GitOps job are all represented.
- Command Center work explicitly references the Prime Directive and adds a development assertion pattern for future CC-01 generalization.

## Concerns

- **HIGH: Malformed overlay handling is internally inconsistent.** Plan 02 says malformed overlays fail closed, but Plan 01’s loader filters invalid ConfigMaps and Plan 02 treats loader errors/null as “no overlay,” which is effectively fail-open if a malformed overlay exists. Distinguish “absent overlay” from “present but invalid overlay.”

- **HIGH: `maxProposalsPerDay` is not really enforced as proposal count.** The annotation is incremented when a capability mint includes a surviving proposal-category tool, not when an actual proposal is issued. If one minted JWT can make multiple proposal actions, the counter undercounts; if the tool is minted but unused, it overcounts.

- **HIGH: Workbench-api likely needs ConfigMap RBAC.** Plan 03 reads disposition ConfigMaps from workbench-api, but only operator RBAC is updated. The workbench chart should grant the API service account `get/list` on ConfigMaps in watched namespaces.

- **HIGH: Command Center does not satisfy “over-budget event count per agent.”** The DTO/UI expose `overBudget` and `overBudgetReason`, but not an over-budget event count. ROADMAP success criterion 4 explicitly requires the count.

- **HIGH: D7 source-binding is too shallow.** Rendered values like token remaining derive from `spentTokensToday` and `idleBehavior.attentionBudget.tokensPerDay`; proposals remaining derives from `proposalsToday` and nested `maxProposalsPerDay`. A single top-level `data-source-field="spentTokensToday"` does not fully prove backing for every visible value.

- **MEDIUM: Exactly-once over-budget emission is only per process.** The in-memory dedup set loses state on restart and duplicates across multiple workbench-api replicas. That is acceptable for a prototype only if the plan weakens the claim to “at most once per process per day.”

- **MEDIUM: Proposals annotation increments can race.** Read-modify-write ConfigMap patching can lose increments under concurrent mints. If this counter matters, use resourceVersion conflict retries or serialize per agent.

- **MEDIUM: Schema-validation Job is not deterministic enough for GitOps.** `npm i js-yaml@4` at Job runtime depends on network/package registry availability. Prefer a prebuilt image, existing project image, or an inline validator without runtime package install.

- **MEDIUM: Plan dependencies understate behavior dependency.** 01-03 depends only on 01-01, but its meaningful `proposalsToday` behavior depends on 01-02 writing annotations. Tests can mock it, but phase sequencing should make the runtime dependency explicit.

- **LOW: Annotation names drift.** `proposals-today-day` and `proposals-today-reset-at` both appear. Standardize on one; the locked context says `kagent.knuteson.io/proposals-today-day`.

## Suggestions

- Change the overlay loader return type to preserve invalid-present state, e.g. `absent | valid | invalid`, and make cap-issuer fail closed only for `invalid`.
- Rename or document `proposalsToday` as `proposalCapMintsToday` unless a real proposal issuance/write path is instrumented.
- Add workbench-api RBAC for listing disposition ConfigMaps in `packages/operator/charts/kagent-workbench`.
- Add `overBudgetEventsToday` or `overBudgetEventCountToday` to `DispositionOverlayRow` and render it in `DispositionOverlay`.
- Replace `sourceField` with `sourceFields` or source paths, e.g. `['spentTokensToday', 'idleBehavior.attentionBudget.tokensPerDay']`.
- Downgrade over-budget audit semantics to “best-effort at-most-once per process per day,” or add a deterministic event id / persistent dedup strategy.
- Add optimistic concurrency/retry around `proposals-today` ConfigMap patching.
- Avoid runtime `npm install` in the schema Job. Use a pinned image or a small checked-in validation script run by the existing operator/workbench image.
- Update plan metadata: 01-03 should note runtime dependency on 01-02 for proposal annotation writes.
- Make `/api/dispositions` mount even when `coreApi` is missing and return `{items: []}`; this avoids UI 404s in local/dev mode.

## Risk Assessment

Overall risk: **MEDIUM-HIGH**.

The scope posture is mostly correct: no new CRD, reconciler, webhook, or new persistence primitive is introduced. The highest risks are not scope creep; they are semantic gaps where the implementation may appear to satisfy DISP-02/03/04 while only approximating them. Fixing malformed overlay fail-closed behavior, workbench-api RBAC, proposal counter semantics, and D7 source provenance would bring the plan down to medium or low-medium risk.

---

## Gemini Review

# Plan Review: Phase 1 — AgentDisposition Prototype

## 1. Summary

The implementation plans for Phase 1 are exceptionally well-aligned with the v0.2 re-steering directives. They successfully bridge the gap between v0.1 workflow stability and v0.2 observation experiments by leveraging existing primitives (ConfigMaps, annotations, and telemetry) to represent complex "disposition" state without a single new CRD or reconciler. The architecture is defensively designed, particularly regarding the **narrow-only** capability enforcement and the **source-bound** UI contract. The progression from setup (01-01) to authority scoping (01-02), cost-visibility (01-03), and finally legibility (01-04) is logical and minimizes context risk.

## 2. Strengths

- **Surgical Adherence to Non-Goals:** The use of a sibling ConfigMap and annotations for cross-process communication (Operator → Workbench API) is an elegant way to avoid introducing new persistence primitives while maintaining GitOps compatibility.
- **Robust "Self-Proposal" Invariant:** Plan 01-02 correctly places the disposition narrowing step _before_ the parent-claim narrowing in the `cap-issuer.ts`. This ensures author intent is constrained at the source and prevents the "self-promotion" risk identified in D6.
- **D7 Contract Enforcement:** The `source-binding.ts` utility in Plan 01-04 is a high-signal implementation of the Prime Directive. Forcing a developer-only throw on orphan UI fields is the strongest possible defense against "UI-only game state."
- **Exhaustive Nyquist Coverage:** The validation strategy (VALIDATION.md) is comprehensive. It explicitly covers failure injection (exactly-once audit emission) and revocation (overlay deletion → fall-through behavior), which are often missed in prototype phases.
- **GitOps-Native Verification:** Task 01-01-T6/T7 cleverly uses a Helm-templated Job to verify the schema in the actual cluster, respecting the "no imperative kubectl" mandate while ensuring the prototype is cluster-ready.

## 3. Concerns

- **N+1 API Pressure (MEDIUM):** In Plan 01-03, Task 2 implements `agentExists` which calls the Kubernetes API (`getNamespacedCustomObject`) for every disposition ConfigMap found. In a cluster with many overlays, this could create significant latency on the `/api/dispositions` endpoint.
- **Rollover Visual Stality (LOW):** Because the `proposals-today` annotation is only updated on a successful mint, a ConfigMap could sit with a "yesterday" timestamp for a long time. While the API projection handles this correctly (treating it as 0), an operator running `kubectl get cm -o yaml` might see confusingly stale data.
- **In-Process De-dup Reset (LOW):** The `overBudgetDedup` set in Plan 01-03 is in-memory. A workbench-api restart will cause "exactly-once-per-day" audit events to re-fire if the condition persists. This is acknowledged in the context but worth noting as a minor observability noise factor.

## 4. Suggestions

- **API Cache Join:** To resolve the N+1 concern in Plan 01-03, use the existing `SnapshotCache` inside the `dispositionsRoute`. If the Agent informer is already watching the namespace, `cache.getAgent(ns, name)` would be a zero-cost local lookup compared to a K8s API round-trip.
- **Annotation Formatting:** In `proposals-counter.ts`, ensure the `kagent.knuteson.io/proposals-today-day` annotation uses a zero-padded format (`YYYY-MM-DD`) to ensure lexical comparisons (if ever needed in `fieldSelectors`) remain reliable.
- **UI Field Visibility:** In `DispositionOverlay.tsx`, consider rendering the `readChannels[]` as a "Reserved" or "Forward-Compat" list (similar to how `postsToday` is handled) to give operators visibility into what the Agent _will_ be watching in future phases.

## 5. Risk Assessment: LOW

The overall risk is **LOW**. The plans introduce no permanent schema changes and rely on a "fail-soft" posture where a missing or malformed overlay simply results in a fall-back to standard v0.1 behavior. The heavy investment in automated unit tests for the narrowing logic (Plan 01-02) and the DTO mapping (Plan 01-03) provides a high degree of confidence that the authority and resource accounting success criteria will be met.

**Status:** **Approved.** Proceed to execution.

---

## OpenCode Review (build · big-pickle)

---

## Consensus Summary

Three independent reviewers (Codex GPT-5.5 xhigh, Gemini, OpenCode) reviewed the four PLAN.md files. Overall verdict ranges from **LOW** (Gemini, OpenCode) to **MEDIUM-HIGH** (Codex). The plans correctly honor the re-steering scope (no new CRD/reconciler/admission webhook/persistence primitive), the D6 self-proposal invariant (overlay narrows, never widens), and the D7 Prime Directive (Command Center source-binding). Disagreement centers on whether known semantic gaps in the proposal counter, fail-open loader path, and source-field shallowness rise to HIGH severity.

### Agreed Strengths (mentioned by 2+ reviewers)

- **ConfigMap carrier choice** is correct — GitOps-friendly, kubectl-inspectable, structured for nested fields, no new CRD (Codex, Gemini)
- **No admission webhook; narrowing in existing cap-issuer mint path** is the right enforcement site (Codex, Gemini, OpenCode)
- **PROPOSAL_TOOL_MAP makes the missing concept explicit** rather than burying string checks (Codex, OpenCode)
- **D7 source-binding helper / dev-only assertion** is high-signal protection against UI-only state (Codex, Gemini, OpenCode)
- **Nyquist coverage is broad** — schema, authority, resource accounting, observability, UI, revocation, GitOps deployability, failure injection (Codex, Gemini, OpenCode)
- **Annotation-writer pattern for proposalsToday** is a clean substitute for adding a NATS consumer to workbench-api (Gemini, OpenCode)
- **Phase boundary discipline** — explicit, repeated declarations of what is OUT of scope, mechanically enforced by grep acceptance criteria (Gemini, OpenCode)

### Agreed Concerns (raised by 2+ reviewers — highest priority)

1. **Loader-failure path is fail-open, not fail-closed** [Codex HIGH, OpenCode MEDIUM]. Plan 01-02 documents fail-closed behavior, but a malformed overlay → loader returns null → `narrowByDispositionOverlay(claims, null)` returns claims unchanged → agent gets FULL proposal authority instead of narrowed. The loader needs to distinguish _absent overlay_ (no narrowing) from _present-but-invalid overlay_ (narrow as if `mayProposeAgainst: []`).

2. **Annotation increment is a read-modify-write race** [Codex MEDIUM, OpenCode MEDIUM]. `incrementProposalsToday` reads the ConfigMap, computes next value, PATCHes — concurrent mints overwrite each other and lose increments. Use `JSONPatch test+replace` (CAS) with retry on conflict, or document as known limitation acceptable for 7-day single-operator observation.

3. **Proposal counter / PROPOSAL_TOOL_MAP semantics drift** [Codex HIGH, OpenCode MEDIUM] — two related concerns:
   - Codex: `maxProposalsPerDay` counter increments on capability mints carrying proposal-category tools, not on actual proposal issuance. Multiple proposals from one mint undercount; minted-but-unused mints overcount. Either rename (`proposalCapMintsToday`) or instrument the actual proposal-issuance path.
   - OpenCode: The minimal mapping `templates → write_artifact` would BLOCK ALL artifact writes for an agent with `mayProposeAgainst: ['verifiers']`, not just template proposals — `write_artifact` is the agent's primary work output in v0.1. Either define proposal-specific tool names (`propose_template`, etc.) that don't yet exist (forward-compat narrowing as a no-op until v0.3+), or add a prominent WARNING comment that operators should not deploy restrictive `mayProposeAgainst` lists in production.

### Codex-only HIGH concerns (worth specific attention)

4. **Workbench-api needs ConfigMap RBAC.** Plan 01-03 reads disposition ConfigMaps from workbench-api but only operator RBAC is updated (in 01-01 Task 3). The kagent-workbench chart should grant the workbench-api ServiceAccount `get/list` on ConfigMaps in watched namespaces.

5. **Command Center missing over-budget event count.** ROADMAP success criterion 4 explicitly requires "budget remaining and over-budget event count per agent." The DTO/UI exposes `overBudget: bool` and `overBudgetReason` but not a count. Add `overBudgetEventCountToday` (or similar) to `DispositionOverlayRow` and render.

6. **D7 source-binding too shallow.** Computed UI values like "tokens remaining" derive from BOTH `spentTokensToday` AND `idleBehavior.attentionBudget.tokensPerDay` — a single `data-source-field="spentTokensToday"` does not fully prove backing for every visible value. Replace `sourceField` with `sourceFields[]` (list) for computed fields.

### Codex-only MEDIUM concerns

- Exactly-once over-budget dedup is per-process — duplicates across replicas / restarts (acknowledged in CONTEXT.md but plan claims should match)
- Schema-validation Job runs `npm install js-yaml@4` at runtime — non-deterministic in air-gapped clusters; prefer prebuilt image
- Plan 01-03 `depends_on: [01-01]` understates runtime dependency on 01-02 writing annotations
- Annotation name drift between `proposals-today-day` and `proposals-today-reset-at` — standardize

### Gemini-only concerns

- **MEDIUM:** N+1 K8s API pressure — `agentExists` calls `getNamespacedCustomObject` per disposition ConfigMap. Use existing `SnapshotCache` informer for O(1) local lookup.
- **LOW:** Stale-day annotation visible to operators in `kubectl get cm -o yaml` (rollover only on next mint).
- **LOW:** In-process dedup reset on workbench-api restart.

### OpenCode-only LOW concerns

- Test fixture READMEs sparse — add per-fixture comments
- `makeEvent` signature check — verify the call shape matches existing codebase
- UTC-midnight dedup edge case — add anti-case test for 23:59:59.999Z → 00:00:00.000Z same-day
- Snapshot tests on `container.innerHTML` are brittle vs CSS module hashes — use stable `data-*` selectors
- `console.warn` noise on cold start when no overlays exist — use `console.debug`
- Duplicate `agentRef` across ConfigMaps silently wins — log `console.warn` on `Map.set` collision

### Divergent Views

- **Overall risk level:** Gemini ("LOW, Approved, Proceed") and OpenCode ("LOW") vs Codex ("MEDIUM-HIGH, the highest risks are not scope creep; they are semantic gaps where the implementation may appear to satisfy DISP-02/03/04 while only approximating them"). Codex is the most adversarial reviewer; Gemini and OpenCode focus on architectural correctness while Codex examines invariant strength.
- **Severity of fail-open loader path:** Codex flags HIGH; OpenCode flags MEDIUM with a similar fix proposal; Gemini does not raise it (suggests Gemini didn't trace the null-overlay path through narrowByDispositionOverlay).
- **Severity of PROPOSAL_TOOL_MAP minimal mapping:** Codex frames it as a counter-semantics problem (HIGH); OpenCode frames it as an over-broad-narrowing risk (MEDIUM). Both fixes converge on "introduce proposal-specific tool names."

### Recommended Action

Run `/gsd-plan-phase 1 --reviews` to incorporate the consensus concerns. Priority order:

1. **Fail-closed loader path** — distinguish `absent` from `present-but-invalid` overlay states (Codex HIGH, OpenCode MEDIUM).
2. **PROPOSAL_TOOL_MAP semantic fix** — define proposal-specific tool names OR document the v0.1 mapping limitation (Codex HIGH, OpenCode MEDIUM).
3. **Workbench-api ConfigMap RBAC** — add to kagent-workbench chart (Codex HIGH).
4. **Over-budget event count** — add to DTO + UI for ROADMAP criterion 4 (Codex HIGH).
5. **D7 source-binding multi-field** — `sourceFields[]` for computed values (Codex HIGH).
6. **Annotation race CAS** — `JSONPatch test+replace` with retry, or document limitation (Codex MEDIUM, OpenCode MEDIUM).
7. Lower-priority items as time permits.
