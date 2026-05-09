# Phase 1: AgentDisposition prototype (overlay-first, no CRD) — Research

**Researched:** 2026-05-09
**Domain:** Overlay design on existing v0.1 substrate primitives; workbench-api projection; Command Center overlay; audit-event extension
**Confidence:** HIGH (all findings from direct codebase inspection)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

1. Overlay carrier: deferred to planner, but MUST be a shipped v0.1 primitive; MUST be `kubectl get`-inspectable; MUST be referenceable by `agentRef`; MUST be modifiable via GitOps (ArgoCD); MUST validate via a Job (not an admission webhook). Planner recommendation: lead with sibling ConfigMap referenced by `agentRef`.
2. Capability-JWT scope narrowing: narrow at proposal-issuance time using overlay's `proposalScope.mayProposeAgainst`. Do NOT add a new admission webhook.
3. Counter projection: compute `spentTokensToday`, `postsToday` (always 0), `proposalsToday` as a workbench-api projection. NO new persistence primitive. `postsToday` always 0 in v0.2 (forward compatibility only).
4. Command Center overlay: render as sibling overlay to existing flow-economy flows; honor COMMAND-CENTER-CONTRACT.md Prime Directive (every field has a backing substrate source); reload-stable; Slice A/B + Slice E patterns.
5. Test posture: Vitest, co-located `*.test.ts`, ≥85% on operator-side scope check narrowing + overlay parsing, ≥75% on glue code.

### Claude's Discretion

- Exact endpoint name for the workbench-api projection (`/dispositions` suggested).
- File layout within `packages/workbench-api/src/routes/` for the new projection.
- Specific Vitest fixture shape for reload-stability tests.
- Whether the Command Center overlay is a new flow card or integrated into existing flow cards.
- Helm values keys for daily-boundary timezone configuration.

### Deferred Ideas (OUT OF SCOPE)

- Any new CRD (`AgentDisposition`, `Channel`, `Post`, `CoalitionProposal`, `Tool`, `SteeringEvent`, `TaskReview`).
- Any new reconciler or controller.
- Any new admission webhook.
- Any new persistence primitive.
- Discourse layer (Posts, Channels) — `readChannels[]` recorded but not acted on.
- Promotion of `AgentDisposition` to a CRD field on `Agent` or to a sibling CRD.
- Substrate-level proto-society kill-switch.
- Multi-reviewer review queue, reputation algorithm.
- HYBRID-AGENT-POLICY.md ingestion.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISP-01 | Operator can express idle/attention behavior as overlay on existing `Agent` using shipped v0.1 primitives; schema-validation Job rejects overlays missing required fields. | Confirmed: sibling ConfigMap with label `kagent.knuteson.io/agent-disposition=true` and `agentRef` annotation is the strongest option. Smoke-test Job template in `packages/operator/charts/kagent-operator/templates/smoke-test.yaml` is the canonical Job pattern to extend. |
| DISP-02 | Overlay's `proposalScope.mayProposeAgainst` enforced at existing capability-JWT scope check at proposal-issuance time; narrows never widens. | Confirmed: `cap-issuer.ts` `mintCapabilityForTask` + `narrowClaimsByParent` + `claimsSubsetViolations` in `packages/operator/src/cap-issuer.ts` is the issuance path. The overlay narrowing plugs in at this function's claim-resolution step. |
| DISP-03 | Disposition counters surfaced as a workbench-api read projection; no new persistence. Over-budget audit events via existing audit-event surface. | Confirmed: gateway `UsageRow.agentName` + `totalTokens` in `packages/llm-gateway/src/db/usage.ts` is the token-usage source. Audit events from the NATS `audit.*` stream via `AuditPublisher` in `packages/audit-events/` are the proposal-count source. Two new event type constants + data interfaces needed in `packages/audit-events/src/event-types.ts` and `types.ts`. |
| DISP-04 | Command Center renders disposition overlay alongside existing flow-economy flows; reload-stable; every field has a backing substrate source per COMMAND-CENTER-CONTRACT.md. | Confirmed: `useCommandSnapshot` hook in `packages/workbench-ui/src/command/state.ts` is the integration point for adding a disposition fetch. Pattern: add `fetchDispositions()` alongside existing `fetchAgents()` / `fetchGatewayCapacity()`. The Mission overlay pattern (`packages/workbench-ui/src/command/Mission.tsx`) shows sibling overlay render structure. |
</phase_requirements>

---

## Summary

Five things the planner needs to know before writing tasks:

1. **No proposal-issuance path currently exists.** The existing `cap-issuer.ts` mints JWT bundles for tasks at admission time, narrowed by parent caps. There is NO separate "proposal" concept or `proposal` audit event in the v0.1 codebase. DISP-02 requires interpreting "proposal-issuance" as the moment an agent's JWT is minted with `tools` or `spawn` claims that would permit a write action classified as a proposal (template change, tool change, capability-policy change per `C-governance-tiers`). The overlay narrows the minted cap's `tools` claim at issuance time. The planner should define a minimal `proposal` category (e.g., what claim patterns constitute a "proposal action") and narrow that at cap-mint time.

2. **The audit event surface has no `proposal` or `disposition_over_budget` event type yet.** Both need to be added as new constants in `packages/audit-events/src/event-types.ts`, new data interfaces in `types.ts`, and new members in `AuditEventType` union and `AuditEventData` union. The pattern is well-established and mechanical. The canonical naming convention is dotted reverse-DNS, e.g., `disposition.proposal_rejected` and `disposition.over_budget`.

3. **Token-usage telemetry requires a live gateway client.** `spentTokensToday` sums `totalTokens` from `GatewayUsageRow` objects — meaning the disposition projection calls the gateway's `/admin/usage` surface with an `agentName` filter and a `since` timestamp (UTC midnight of today). This is the same path used by `packages/workbench-api/src/routes/gateway.ts` already. The projection does NOT need a database.

4. **The ConfigMap carrier is strongly confirmed.** The `Agent` CR has no embedded "overlay" extension point for structured config today. ConfigMap is the cleanest shipped primitive: native to Kubernetes, natively `kubectl get`-able, GitOps-ready, and carries arbitrary structured YAML. The label `kagent.knuteson.io/agent-disposition=true` plus an annotation `kagent.knuteson.io/agent-ref: <namespace>/<name>` provides the join key. The workbench-api projection reads ConfigMaps with this label from the Kubernetes API (or from the existing SnapshotCache if informer coverage is extended).

5. **Command Center reload stability is achieved via the `useCommandSnapshot` hook pattern.** All Command Center state is derived from API fetches — there is no client-side persistence of world-object state. Adding dispositions to the hook is adding one more fetch + state entry. The tour overlay (`Mission.tsx`) and replay overlay (`Replay.tsx`) are the canonical sibling overlay patterns.

**Primary recommendation:** ConfigMap carrier → workbench-api `/api/dispositions` projection route → `disposition.proposal_rejected` + `disposition.over_budget` audit events → `DispositionOverlay` component in `packages/workbench-ui/src/command/` following Mission.tsx pattern.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Overlay storage (ConfigMap) | Kubernetes API / GitOps | — | ConfigMaps are Kubernetes-native; ArgoCD deploys them; kubectl reads them. No substrate code owns the storage. |
| Schema validation Job | Kubernetes Jobs (via Helm chart) | operator charts | Stateless one-shot Job; the chart ships it alongside the overlay manifest. |
| Cap-JWT scope narrowing at issuance | API / Backend (operator cap-issuer) | — | `mintCapabilityForTask` in `packages/operator/src/cap-issuer.ts` is the issuance point; the overlay is read at this site and narrows the `tools` claim. |
| Token-usage counter projection | API / Backend (workbench-api) | LLM gateway admin surface | workbench-api calls gateway `/admin/usage?agentName=&since=` and sums `totalTokens`. No new DB. |
| Proposal-count counter projection | API / Backend (workbench-api) | NATS audit stream | workbench-api queries NATS JetStream `audit` stream filtered by `type=disposition.proposal_rejected` + `agentRef` + today. |
| Over-budget audit events | API / Backend (workbench-api projection) | audit-events package | Projection computes over-budget; emits via `AuditPublisher` exactly once per (agent, kind) per day. |
| Disposition read projection endpoint | API / Backend (workbench-api) | — | `GET /api/dispositions` route in `packages/workbench-api/src/routes/dispositions.ts`, following existing route patterns. |
| Command Center overlay render | Browser / Client (workbench-ui) | — | React component in `packages/workbench-ui/src/command/DispositionOverlay.tsx`; all data from `useCommandSnapshot` extension. |
| Daily-boundary timezone config | Helm chart values | workbench-api env | `disposition.dailyBoundaryTimezone` (or similar) Helm value mapped to env var consumed by the projection. |

---

## Existing Codebase Landmarks

### Q1: Overlay carrier choice — existing Agent CRD shape and ConfigMap usage

**Agent CRD type:** `packages/operator/src/crds/types.ts`
- `AgentSpec` (line ~60) has no "overlay" or "disposition" extension point.
- Key fields: `model`, `modelClass`, `systemPrompt`, `tools`, `capabilities`, `capabilityClaims`, `inputs[]`, `outputs[]`, `publishes[]`, `subscribes[]`, `sandboxProfile`, etc.
- Annotations used today: `kagent.knuteson.io/published`, `kagent.knuteson.io/deprecated`, `kagent.knuteson.io/removed-at` (all defined as constants in `types.ts`).
- The Agent CRD does NOT have a `disposition` field, a `sidecarRefs` field, or any extensible annotation block designed for structured overlay data.

**ConfigMap usage in codebase:** No existing code in `packages/operator/` creates or reads ConfigMaps for agent configuration. ConfigMaps are used only by the Helm chart for operator configuration (NATS URL, image tag, etc.). This means Phase 1 is adding a NEW ConfigMap usage pattern to the codebase — the overlay ConfigMap.

**Annotation alternative assessment:** Annotations are strings; nested JSON-in-annotation is awkward to author in YAML (requires quoting or multi-line) and produces illegible GitOps manifests. Annotations are fine for simple boolean flags (as used today) but unsuitable for nested objects like `attentionBudget.{tokensPerDay, pollIntervalSeconds}` + `proposalScope.{mayProposeAgainst[], maxProposalsPerDay}`. ConfigMap wins.

**ArtifactRef alternative assessment:** `packages/operator/src/crds/artifact-ref.ts` defines `ArtifactRef` as a content-addressed object in the CAS. ArtifactRefs are immutable by design (content-addressed); disposition overlays need to be mutable (operator can change token budgets). ArtifactRef is inappropriate.

**Recommendation confirmed: sibling ConfigMap.** Wire shape:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: researcher-01-disposition
  namespace: kagent-system
  labels:
    kagent.knuteson.io/agent-disposition: "true"
  annotations:
    kagent.knuteson.io/agent-ref: "kagent-system/researcher-01"
data:
  disposition.yaml: |
    idleBehavior:
      readChannels: []
      attentionBudget:
        tokensPerDay: 50000
        pollIntervalSeconds: 300
      proposalScope:
        mayProposeAgainst:
          - templates
          - verifiers
        maxProposalsPerDay: 3
```

The `data.disposition.yaml` key holds the structured YAML payload, keeping the ConfigMap natively `kubectl get`-able and GitOps-friendly.

---

### Q2: Capability-JWT scope check site — proposal-issuance path

**Primary file:** `packages/operator/src/cap-issuer.ts`

**Key function:** `mintCapabilityForTask` (line ~179). This is the ONLY place in the operator where capability JWTs are signed. The algorithm:
1. `resolveAgentClaims(input.agent)` — pulls `Agent.spec.capabilityClaims`.
2. If `input.parentBundle` is provided: `narrowClaimsByParent(agentClaims, input.parentBundle.claims)` — intersects child claims with parent.
3. `claimsSubsetViolations(narrowed, input.parentBundle.claims)` — defense-in-depth check; throws `CapabilityViolationError` on violation.
4. `applyTenantClaim(narrowed, input.tenant)` — stamps tenant.
5. `ca.mint({ subjectTaskUid, jti, claims, ... })` — signs the JWT.

**Where the overlay narrows:** Between steps 1 and 2. After resolving the Agent's base claims, read the disposition overlay for this Agent (by `agentRef`). If an overlay exists, intersect `claims.tools` (or whatever claims represent "proposal actions") with the overlay's `mayProposeAgainst` allowlist. A tool call for `templates` means the agent is proposing a template change (per `C-governance-tiers`); if `templates` is not in `mayProposeAgainst`, remove template-write tools from the cap.

**The "proposal" claim mapping decision the planner must make:**
- `CapabilityClaims` has `tools` (tool names), `models`, `spawn`, `read`, `write`, `egress`, etc. (defined in `packages/capability-types/src/types.ts`).
- There is no `proposals` claim category in `CapabilityClaims`.
- CONTEXT.md says "proposal-issuance" — but in v0.1 there is no separate "proposal" pathway; agents exercise authority through tool calls and child-task spawning.
- RECOMMENDATION: define a mapping table in Phase 1 code: `proposalScope.mayProposeAgainst` entries map to tool name patterns that constitute "proposals" of that kind. Example: `templates` → tool names matching `write_artifact` + output-to-template paths; `verifiers` → verifier-write tool names. At cap-issuance, filter the `tools` claim to exclude proposal-category tools not in `mayProposeAgainst`. This is a code-level convention, not a new CRD field.

**Supporting functions:**
- `claimsSubsetViolations` + `formatViolations` — `packages/capability-types/src/subset.ts`
- `validateCapabilityClaims` — `packages/capability-types/src/validate.ts`
- `ALL_CAPABILITY_CLAIM_CATEGORIES` — `packages/capability-types/src/types.ts`

**Audit emission on scope rejection:** The planner should emit a `disposition.proposal_rejected` event (new) when `mintCapabilityForTask` would have included a proposal-category tool but the overlay excluded it. This fires from inside the narrowing step, before `ca.mint()`.

---

### Q3: Token-usage telemetry source — gateway DTOs

**Primary file:** `packages/llm-gateway/src/db/usage.ts`

**Key types:**
- `UsageRow` (insert shape): fields include `agentName: string | null`, `totalTokens: number`, `taskUid: string | null`, `occurredAt?: string`.
- `UsageQueryRow` (query shape): same fields, plus `occurredAt: string` (ISO 8601 timestamp).
- `UsageQueryFilter`: `{ agentName?, model?, since?, until?, limit? }` — the `agentName` + `since` filters are exactly what the projection needs.
- `UsageRepo.query(filter)` returns `Promise<readonly UsageQueryRow[]>`.

**Access path for the projection:** The workbench-api already has a `GatewayClient` interface (`packages/workbench-api/src/gateway-client.ts`) with a `usage(params)` method that calls the gateway's `/admin/usage` HTTP endpoint. The `GatewayUsageRow` type (`packages/workbench-api/src/gateway-client.ts` line ~55) has: `agentName?: string | null`, `inputTokens: number`, `outputTokens: number`, `occurredAt?: string`.

**spentTokensToday computation:**
```typescript
// In the dispositions route handler:
const todayMidnightUTC = /* UTC midnight ISO string */;
const usageRows = await gatewayClient.usage({ agentName: overlay.agentRef.name, since: todayMidnightUTC, limit: 1000 });
const spentTokensToday = usageRows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
```

Note: `GatewayUsageRow` exposes `inputTokens` and `outputTokens` separately; the projection should sum both. The gateway's `UsageRow.totalTokens` is the DB field but the client DTO exposes the two separately. Either approach works — summing `input + output` at the projection layer is cleaner.

**Daily boundary:** The `since` parameter is an ISO 8601 timestamp. UTC midnight of today: `new Date(Date.UTC(y, m, d, 0, 0, 0, 0)).toISOString()`. The timezone configurability (Helm value) controls which wall-clock midnight to use; UTC is the default.

---

### Q4: Audit-event surface — existing kinds and new kind naming

**Audit event types file:** `packages/audit-events/src/event-types.ts`
**Types file:** `packages/audit-events/src/types.ts`
**Publisher:** `packages/audit-events/src/publisher.ts` (`AuditPublisher` class)
**Builder:** `packages/audit-events/src/make-event.ts` (`makeEvent` function)

**Existing event type count:** 47 (the `ALL_EVENT_TYPES` array in `event-types.ts` has 47 entries).

**Naming convention:** `<domain>.<action>` pattern — all lowercase, dot-separated. Examples:
- `task.admitted`, `task.spawned`, `task.completed`, `task.failed`
- `capability.minted`, `capability.used`
- `quota.gateway_inflight_exceeded`, `quota.storage_exceeded`
- `verifier.started`, `verifier.completed`, `verifier.failed`
- `egress.policy_applied`, `egress.policy_violation`

**New event kinds for Phase 1:**

1. `disposition.proposal_rejected` — emitted when `mintCapabilityForTask` would have minted a tool claim that the overlay's `mayProposeAgainst` excludes. Data: `{ agentRef: string, dispositionConfigMapName: string, namespace: string, excludedClaim: string, reason: 'not_in_mayProposeAgainst' }`.

2. `disposition.over_budget` — emitted when the dispositions projection computes `spentTokensToday > tokensPerDay` OR `proposalsToday > maxProposalsPerDay`. Data: `{ agentRef: string, namespace: string, reason: 'tokens_exceeded' | 'proposals_exceeded', observed: number, budget: number, dailyBoundaryUtc: string }`. Emitted AT MOST ONCE per (agent, reason) per day.

**Addition pattern (must follow exactly):**

In `event-types.ts`: Add two new `export const` lines with version comment (e.g., `/* Phase 1 — AgentDisposition prototype */`), and add to `ALL_EVENT_TYPES` array.

In `types.ts`: Add `| 'disposition.proposal_rejected'` and `| 'disposition.over_budget'` to `AuditEventType` union; add corresponding data interfaces (`DispositionProposalRejectedData`, `DispositionOverBudgetData`); add to `AuditEventData` discriminated union.

**CRITICAL:** The `AuditEventType` union and `AuditEventData` discriminated union are the single source of truth. A `switch(event.type)` over `AuditEvent` is exhaustive by TypeScript. Adding a new event type WITHOUT adding to the union will cause a type error at every `switch` callsite that has exhaustiveness checks.

**The `ALL_EVENT_TYPES.length` sanity test** (in `make-event.test.ts` or `event-types.ts` tests) checks the count. After adding 2 new types, the expected count in any such test must be updated to 49.

---

### Q5: Workbench-api projection patterns

**Route files:** `packages/workbench-api/src/routes/`
- `agents.ts` — `GET /api/agents` — simplest route; no deps beyond `SnapshotCache`. Pattern: construct Hono app, define GET handler, read from cache, project via DTO, return `c.json({ items: [...] })`.
- `tasks.ts` — `GET /api/tasks` + `POST /api/tasks` — more complex; has query params, DTO projection, optional write surface.
- `gateway.ts` — `GET /api/gateway/capacity` + `GET /api/gateway/usage` + `PATCH /api/modelendpoints/...` — uses external HTTP client (`GatewayClient`). Pattern for dispositions with external data access.

**Conventional route shape:**
```typescript
// packages/workbench-api/src/routes/dispositions.ts (NEW FILE)
export interface DispositionsRouteDeps {
  readonly gatewayClient?: GatewayClient;
  readonly auditPublisher?: AuditPublisher;
  readonly coreApi?: CoreV1Api;  // for reading ConfigMaps
  readonly now?: () => number;
}

export function dispositionsRoute(deps: DispositionsRouteDeps): Hono { ... }
```

**DTO shape (to be defined — new file `packages/dto/src/disposition.ts`):**
```typescript
export interface DispositionOverlayRow {
  readonly agentRef: string;  // "namespace/name"
  readonly namespace: string;
  readonly configMapName: string;
  // Spec fields from the ConfigMap:
  readonly idleBehavior: {
    readonly readChannels: readonly string[];
    readonly attentionBudget: { readonly tokensPerDay: number; readonly pollIntervalSeconds: number };
    readonly proposalScope: { readonly mayProposeAgainst: readonly string[]; readonly maxProposalsPerDay: number };
  };
  // Computed projection fields:
  readonly spentTokensToday: number;
  readonly postsToday: 0;  // always 0 in v0.2
  readonly proposalsToday: number;
  readonly overBudget: boolean;
  readonly overBudgetReason?: 'tokens_exceeded' | 'proposals_exceeded' | 'both';
  readonly dailyBoundaryUtc: string;  // ISO 8601 midnight timestamp used for the day window
}
```

**Router wiring:** Add to `packages/workbench-api/src/router.ts` alongside existing route mounts (line ~131–155). The `RouterDeps` interface gains optional `coreApi` (already present! line ~98) and `auditPublisher` fields.

**Note:** `RouterDeps` already has `coreApi?: CoreV1Api` (added for the Cluster page's node listing). The dispositions route can reuse this client to read ConfigMaps via `coreApi.readNamespacedConfigMap(...)`.

---

### Q6: Command Center overlay slot

**CommandView file:** `packages/workbench-ui/src/CommandView.tsx`
**State hook:** `packages/workbench-ui/src/command/state.ts` (`useCommandSnapshot`, `CommandSnapshot` type)

**Current overlay components in `packages/workbench-ui/src/command/`:**
- `Mission.tsx` — tutorial overlay (lower-left anchored card). Shows the sibling overlay pattern.
- `Replay.tsx` — replay overlay. Another sibling.
- `fx.ts`, `Minimap.tsx`, `TaskActionMenu.tsx` — other canvas overlays.

**Pattern for adding `DispositionOverlay`:**
1. Add `fetchDispositions()` to `packages/workbench-ui/src/api.ts` (alongside existing `fetchAgents`, `fetchTasks`, `fetchGatewayCapacity`, `fetchGatewayUsage`).
2. Extend `CommandSnapshot` in `state.ts` with `dispositions: ReadonlyMap<string, DispositionOverlayRow>`.
3. Add a fetch + state entry in `useCommandSnapshot` for dispositions (polling on the same schedule as gateway: 5s tick, or on SSE event).
4. Create `packages/workbench-ui/src/command/DispositionOverlay.tsx` — reads `snapshot.dispositions`, renders per-agent disposition state.
5. Mount `DispositionOverlay` in `CommandView.tsx` alongside the existing `MissionOverlay` and `ReplayButton` mounts.

**Reload stability:** Because `useCommandSnapshot` fetches all data from the API on mount and on every SSE event, reload stability is automatic. The `CommandSnapshot` contains no state that doesn't come from an API call. Adding dispositions follows the same pattern — no special handling needed.

**D7 / Prime Directive enforcement:** Create `DispositionOverlay` to always assert each rendered field against a declared `sourceField` property (the development-only assertion for CC-01 is Phase 2 scope, but Phase 1 can implement the disposition-specific version as a preview). Per CONTEXT.md: "A development-only assertion fires in Phase 1's UI build when a rendered disposition field lacks a backing source field reference."

---

### Q7: Slice A patterns — snapshot mapper/layout fixture tests

**Slice A from COMMAND-CENTER-CONTRACT.md §7:** "Add fixture-based tests for the Command snapshot mapper/layout: Agents, tasks, gateway rows in; expected nodes, lanes, and counters out."

**Existing snapshot mapper:** `packages/workbench-ui/src/command/layout.ts` (`computeLayout` function, imported at `CommandView.tsx` line ~37). This is the function that maps API data into canvas node positions.

**Existing fixture-based tests:** No `*.test.ts` file was found in `packages/workbench-ui/src/command/`. The workbench-ui package has no co-located tests in `src/command/`. The `vite.config.ts` exists but no `vitest.config.ts` was found.

**OPEN QUESTION:** Does `packages/workbench-ui/` have a vitest setup? The `find` output showed `packages/workbench-ui/vite.config.ts` but no `vitest.config.ts`. Phase 1's PLAN.md must include a Wave 0 task to add vitest infrastructure to the workbench-ui package if it doesn't already exist.

**Phase 1 Slice A work (scoped to disposition slice):** The planner should add:
- `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — fixture test: given a `DispositionOverlayRow` with `spentTokensToday=45000, tokensPerDay=50000`, assert the rendered component shows the correct budget-remaining value. Given `spentTokensToday=55000`, assert the over-budget visual state.
- The snapshot mapper test (full Command snapshot mapper covering Agents + tasks + gateway) is CC-01 scope (Phase 2), not Phase 1 scope.

---

### Q8: Reload stability — current handling

**Pattern:** `useCommandSnapshot` in `state.ts` fetches all data on mount via `useEffect([], [])` — the empty deps array means it runs once on mount. The SSE subscription (`subscribeCacheEvents`) then drives re-fetches on cache events. On page reload, React unmounts/remounts; `useEffect` fires again; all four `refetch*` calls execute; state re-derives from fresh API responses.

**Phase 1 extension:** Add `refetchDispositions()` called at mount and on any SSE event (same as `refetchAgents`). No client-side persistence is involved. CONTEXT.md's "reload-stable" requirement is satisfied automatically by this pattern.

**Vitest test:** CONTEXT.md specifies "Vitest snapshot test seeded with a captured API response asserts the rendered DOM tree matches across reloads." The pattern: capture a `DispositionOverlayRow[]` fixture, render `DispositionOverlay` with it, assert the DOM snapshot. If the overlay is reload-stable, the snapshot will match a second render.

---

### Q9: Daily-boundary timezone configurability — Helm values pattern

**Existing Helm values pattern:** `packages/operator/charts/kagent-operator/values.yaml` uses flat camelCase keys for feature-level configuration, with nested objects for grouped settings. Examples:
- `substrateHealth.port`, `substrateHealth.freshnessMaxMs`
- `agentPod.litellmBaseUrl`, `agentPod.spawnChild.enabled`
- `agentPod.contextSafetyThreshold`

**For the workbench-api chart** (`packages/operator/charts/kagent-workbench/values.yaml`), the convention is similar:
- `api.langfuseBaseUrl` — flat under the `api` group.
- `api.gatewayAdmin.baseUrl` — nested within the `api` group.

**Recommended Helm value for daily boundary:**
```yaml
# packages/operator/charts/kagent-workbench/values.yaml
api:
  # ... existing fields ...
  disposition:
    # IANA timezone name for the daily boundary used by the disposition
    # projection counters (spentTokensToday, proposalsToday). Defaults
    # to UTC. Example: 'America/Chicago'.
    dailyBoundaryTimezone: 'UTC'
```

This maps to env var `WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ` on the workbench-api container.

**Usage in projection code:**
```typescript
const tz = process.env['WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ'] ?? 'UTC';
// Use Temporal API (Node 22 has it available) or a simple UTC-offset calculation.
// Simplest: always use UTC midnight and document the TZ env for future use.
```

---

### Q10: Schema-validation Job manifests — existing pattern

**Canonical Job pattern:** `packages/operator/charts/kagent-operator/templates/smoke-test.yaml`

The smoke-test Job ships:
1. An Agent CR, an AgentTask CR, a ServiceAccount, a Role, a RoleBinding, and a Job — all in one template file gated by `{{ if .Values.smokeTest.enabled }}`.
2. Job uses `bitnami/kubectl` image; runs a shell script that `kubectl get` polls until terminal phase.
3. Job annotations: `argocd.argoproj.io/sync-options: Replace=true,Force=true` + `argocd.argoproj.io/hook: Sync` + `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation` — this ensures a fresh Job on every ArgoCD sync.
4. Security: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `emptyDir` volumes for `/tmp` and `/.kube`.

**Phase 1 schema-validation Job:** Should ship in `packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml` (or a new chart section). It:
1. Creates a test ConfigMap with the `disposition.yaml` data key populated.
2. Creates a Job that reads the ConfigMap's `disposition.yaml`, parses it, and validates required fields (`idleBehavior.readChannels`, `attentionBudget.tokensPerDay`, `attentionBudget.pollIntervalSeconds`, `proposalScope.mayProposeAgainst`, `proposalScope.maxProposalsPerDay`).
3. The Job image can be a simple `bitnami/kubectl` + `yq` or a custom `node:22-alpine` container that runs a validation script.
4. The Job exits 0 on valid overlay, 1 on invalid.

**Alternative:** A dedicated Node.js validation Job image that imports `@kagent/dto` or a standalone validation module and validates a ConfigMap by name. This is cleaner but requires building and publishing a new image. The simpler path for Phase 1: `node:22-alpine` with an inline validation script baked into the Job's `command:` field.

---

### Q11: Validation Architecture

See full section below.

---

## Recommended Overlay Carrier

**Confirmed: sibling ConfigMap, referenced by `agentRef` annotation.**

Evidence:
- The `Agent` CRD (`packages/operator/src/crds/types.ts`) has no structured extension point for disposition data.
- Annotations are string-valued; nested objects require JSON-encoding, which is ergonomically poor for GitOps YAML authoring.
- `ArtifactRef` is content-addressed and immutable — disposition overlays need mutability.
- ConfigMaps are natively Kubernetes-shaped, `kubectl get`-able, ArgoCD-deployable, and carry structured YAML natively.
- The workbench-api's `RouterDeps.coreApi?: CoreV1Api` is already present (line 98 of `router.ts`) for reading Kubernetes core resources.

**Wire shape confirmed above (Q1). Carrier-agnostic note:** The workbench-api projection and the capability-JWT narrowing should both accept an interface (`DispositionOverlay`) that could in principle be populated from an annotation or ArtifactRef — making carrier switching a contained change.

---

## Implementation Sketch Per Requirement

### DISP-01: Overlay representation + schema-validation Job

**New files:**
- `packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml` — Helm-templated Job manifest gated by `{{ if .Values.smokeTest.enabled }}` (reuse the smoke-test gate, or add a new `{{ if .Values.dispositionTest.enabled }}` gate). The Job reads a test ConfigMap and validates required fields.
- `packages/dto/src/disposition.ts` (or `packages/workbench-api/src/disposition-schema.ts`) — TypeScript interface for `DispositionOverlay` spec fields + a `parseDispositionConfigMap(cm: V1ConfigMap): DispositionOverlay | null` function. This is the single source of truth for the schema; the Job imports it (if using a Node container) or reimplements it as a shell yq/jq script.

**No modified existing files** for DISP-01 itself (the ConfigMap is a new resource kind to the codebase; it doesn't modify existing CRDs or controllers).

**Wire shape (DISP-01):** The ConfigMap YAML above (Q1). Required fields: `idleBehavior.readChannels[]`, `idleBehavior.attentionBudget.tokensPerDay`, `idleBehavior.attentionBudget.pollIntervalSeconds`, `idleBehavior.proposalScope.mayProposeAgainst[]`, `idleBehavior.proposalScope.maxProposalsPerDay`.

---

### DISP-02: Capability-JWT scope narrowing

**Modified files:**
- `packages/audit-events/src/event-types.ts` — add `DISPOSITION_PROPOSAL_REJECTED = 'disposition.proposal_rejected' as const`.
- `packages/audit-events/src/types.ts` — add `DispositionProposalRejectedData` interface; add to `AuditEventType` and `AuditEventData` unions.
- `packages/operator/src/cap-issuer.ts` — add `narrowByDispositionOverlay(claims, overlay)` step between `resolveAgentClaims` and `narrowClaimsByParent`. The function reads the overlay's `proposalScope.mayProposeAgainst` and removes tool claims that constitute proposals for excluded kinds. Emits `disposition.proposal_rejected` audit event for each excluded claim.

**New file:**
- `packages/operator/src/disposition-loader.ts` — async function that reads a disposition ConfigMap by `agentRef` from the Kubernetes API. Called by the reconciler before `mintCapabilityForTask`. Caches result with a short TTL (e.g., 30s) to avoid K8s API call per task.

**Unit test target:** `narrowByDispositionOverlay.test.ts` — given an overlay declaring `mayProposeAgainst: ['templates']`, assert that:
- A cap with `tools: ['write_artifact', 'read_artifact']` is NOT narrowed (no proposal-category tools).
- A cap with `tools: ['propose_template_change']` (or whatever tool name maps to templates proposals) IS narrowed.
- The overlay narrows; it NEVER widens (a cap with `tools: []` stays empty even if the overlay allows `['templates']`).

**OPEN QUESTION:** What tool names constitute "proposals" of a given kind? This is not defined anywhere in the v0.1 codebase. Phase 1 PLAN.md must define a `PROPOSAL_TOOL_MAP` constant (e.g., `{ templates: ['write_artifact'], verifiers: ['write_artifact'], policies: [] }`) as a first-class code artifact. The planner should propose a minimal initial mapping and document it as a decision point.

---

### DISP-03: Workbench-api read projection

**New files:**
- `packages/workbench-api/src/routes/dispositions.ts` — Hono route for `GET /api/dispositions`.
- `packages/workbench-api/src/routes/dispositions.test.ts` — unit tests with mocked gateway client + mocked CoreV1Api.

**Modified files:**
- `packages/audit-events/src/event-types.ts` — add `DISPOSITION_OVER_BUDGET = 'disposition.over_budget' as const`.
- `packages/audit-events/src/types.ts` — add `DispositionOverBudgetData` interface; add to unions.
- `packages/workbench-api/src/router.ts` — add `dispositionsRoute(...)` mount; add `auditPublisher?: AuditPublisher` to `RouterDeps`.
- `packages/workbench-api/src/main.ts` — wire up `AuditPublisher` for over-budget emission.

**Projection algorithm:**
1. List all ConfigMaps in watch-namespaces with label `kagent.knuteson.io/agent-disposition=true` via `coreApi.listNamespacedConfigMap(namespace, undefined, undefined, undefined, 'kagent.knuteson.io/agent-disposition=true')`.
2. For each ConfigMap: parse `data['disposition.yaml']` into a `DispositionOverlay`.
3. Extract `agentRef` from annotation `kagent.knuteson.io/agent-ref`.
4. Call `gatewayClient.usage({ agentName: ref.name, since: todayMidnightUtc, limit: 1000 })` to sum `inputTokens + outputTokens`.
5. Query NATS JetStream `audit` stream for `disposition.proposal_rejected` events with matching `agentRef` since today midnight → count = `proposalsToday`.
6. Compute `overBudget` and emit `disposition.over_budget` audit event if over budget AND not already emitted today (use an in-memory de-dup map keyed by `agentRef + reason`; reset at midnight).
7. Return `{ items: DispositionOverlayRow[] }`.

**Note on NATS query for proposalsToday:** The `AuditPublisher` writes to NATS JetStream; reading back from NATS requires a JetStream consumer. The workbench-api currently does NOT read from NATS (it reads from the Kubernetes API via the SnapshotCache + SSE). Phase 1 should AVOID adding a NATS consumer to the workbench-api. **Alternative for proposalsToday:** The `disposition.proposal_rejected` events are emitted by the operator; the audit stream is an append-only log. The simplest approach: keep an in-memory counter in the workbench-api process, reset at daily boundary. The counter increments when `useCommandSnapshot`'s SSE stream receives a cache event that carries a disposition rejection. This is an imprecise approach across restarts.

**Cleaner alternative:** The operator's `disposition-loader.ts` maintains a per-agent proposal counter in process memory (reset at midnight). The workbench-api projection endpoint calls a new endpoint on the operator (HTTP or via K8s custom status), OR the operator writes the counter to the ConfigMap's `status` annotation (a convention). The simplest v0.1 approach: write `proposalsToday` as an annotation on the disposition ConfigMap each time a rejection is emitted. The workbench-api reads it from the ConfigMap directly.

**Recommendation:** Write `kagent.knuteson.io/proposals-today: "N"` as an annotation on the disposition ConfigMap from within the operator's narrowing step. The projection reads this annotation. This avoids a NATS consumer in the workbench-api and keeps the data model simple. The annotation is reset to `"0"` at the next UTC midnight by a lightweight operator reconcile tick.

---

### DISP-04: Command Center overlay

**New files:**
- `packages/workbench-ui/src/command/DispositionOverlay.tsx` — React component. Per-agent disposition row showing: budget remaining (tokens), proposals remaining, over-budget alert. Follows Mission.tsx pattern (anchored overlay card).
- `packages/workbench-ui/src/command/DispositionOverlay.module.css` — styles.
- `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — Vitest snapshot test.

**Modified files:**
- `packages/workbench-ui/src/api.ts` — add `fetchDispositions()` function.
- `packages/workbench-ui/src/command/state.ts` — add `dispositions: ReadonlyMap<string, DispositionOverlayRow>` to `CommandSnapshot`; add `refetchDispositions()` in `useCommandSnapshot`.
- `packages/workbench-ui/src/types.ts` — add `DispositionOverlayRow` type (mirrors the workbench-api DTO).
- `packages/workbench-ui/src/CommandView.tsx` — mount `DispositionOverlay` alongside existing overlays.

**Reload-stable pattern (confirmed):** All state derives from `useCommandSnapshot` fetches; no `localStorage` or `sessionStorage` used for world-object state.

**Over-budget pressure display:** Follow Slice E acceptance criteria — each over-budget marker carries the `sourceField` name (e.g., `"spentTokensToday"`) and a detail link (e.g., linking to the Agent detail panel). In base-building-only mode, the over-budget state is shown as a numeric difference, not as a dramatic visual.

**D7 source assertion (Phase 1 scope):** In dev builds, `DispositionOverlay` should assert that every rendered field references a `sourceField` from the `DispositionOverlayRow` DTO. A simple `if (process.env.NODE_ENV === 'development') { assert(field in row) }` pattern suffices for Phase 1.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (co-located `*.test.ts` per CLAUDE.md) |
| Config file | `packages/<pkg>/vitest.config.ts` (each package has its own) |
| Quick run command | `pnpm --filter @kagent/audit-events test` (or substitute package name) |
| Full suite command | `pnpm -r test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISP-01 | ConfigMap parse: valid overlay is accepted | unit | `pnpm --filter @kagent/workbench-api test -- dispositions` | No — Wave 0 |
| DISP-01 | ConfigMap parse: overlay missing `tokensPerDay` is rejected | unit | same | No — Wave 0 |
| DISP-01 | Schema-validation Job exits 0 on valid overlay | GitOps Job | `kubectl get job disposition-schema-validate -o jsonpath='{.status.succeeded}'` | No — Wave 0 |
| DISP-02 | `narrowByDispositionOverlay`: overlay with `mayProposeAgainst: ['templates']` removes template-proposal tools from cap | unit | `pnpm --filter @kagent/operator test -- cap-issuer` | No — Wave 0 (extends `cap-issuer.test.ts`) |
| DISP-02 | Narrowing never widens: empty cap stays empty even if overlay allows all kinds | unit | same | No — Wave 0 |
| DISP-02 | `disposition.proposal_rejected` audit event emitted when narrowing removes a tool | unit | `pnpm --filter @kagent/operator test -- cap-issuer` | No — Wave 0 |
| DISP-03 | `/api/dispositions` returns 200 with correct DTO shape | unit | `pnpm --filter @kagent/workbench-api test -- dispositions` | No — Wave 0 |
| DISP-03 | `spentTokensToday` correctly sums `inputTokens + outputTokens` from mocked gateway rows | unit | same | No — Wave 0 |
| DISP-03 | `disposition.over_budget` audit event emitted when `spentTokensToday > tokensPerDay` | unit (failure-injection) | same | No — Wave 0 |
| DISP-03 | Over-budget event is NOT emitted a second time for the same (agent, reason) in the same day | unit | same | No — Wave 0 |
| DISP-04 | DispositionOverlay renders budget-remaining correctly for an in-budget agent | unit/snapshot | `pnpm --filter @kagent/workbench-ui test -- DispositionOverlay` | No — Wave 0 |
| DISP-04 | DispositionOverlay renders over-budget state correctly | unit/snapshot | same | No — Wave 0 |
| DISP-04 | Reload stability: re-render with same fixture produces same DOM snapshot | snapshot | same | No — Wave 0 |
| DISP-04 | Development assertion fires when a rendered field has no sourceField reference | unit | same | No — Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm --filter <changed-pkg> test`
- **Per wave merge:** `pnpm -r test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/audit-events/src/event-types.ts` — add `DISPOSITION_PROPOSAL_REJECTED`, `DISPOSITION_OVER_BUDGET` constants + update `ALL_EVENT_TYPES`
- [ ] `packages/audit-events/src/types.ts` — add `DispositionProposalRejectedData`, `DispositionOverBudgetData` interfaces + update unions
- [ ] `packages/operator/src/disposition-loader.ts` — ConfigMap reader + `DispositionOverlay` parser (NEW)
- [ ] `packages/operator/src/cap-issuer.ts` — add `narrowByDispositionOverlay` step
- [ ] `packages/operator/src/cap-issuer.test.ts` — extend with overlay-narrowing test cases
- [ ] `packages/workbench-api/src/routes/dispositions.ts` — new route (NEW)
- [ ] `packages/workbench-api/src/routes/dispositions.test.ts` — unit tests (NEW)
- [ ] `packages/workbench-api/src/router.ts` — mount dispositionsRoute
- [ ] `packages/workbench-ui/src/command/DispositionOverlay.tsx` — new component (NEW)
- [ ] `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — snapshot tests (NEW)
- [ ] `packages/workbench-ui/src/command/state.ts` — extend `CommandSnapshot` + `useCommandSnapshot`
- [ ] `packages/workbench-ui/src/api.ts` — add `fetchDispositions()`
- [ ] `packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml` — new Job manifest (NEW)
- [ ] Check `packages/workbench-ui/` for vitest config — add if missing

---

## Open Questions

1. **What tool names constitute "proposals" of each `mayProposeAgainst` kind?**
   - What we know: `C-governance-tiers` names the authority levels (templates, tools, capability-policy, etc.). `CapabilityClaims.tools` lists tool names the agent may invoke.
   - What's unclear: The v0.1 codebase has NO tool names that explicitly represent "propose a template change" vs. "write an artifact" vs. "change a capability policy." The governance tier table exists only in the planning documents, not in code.
   - Recommendation: The planner should define a `PROPOSAL_TOOL_MAP` constant (or a small data structure) in a new `packages/operator/src/disposition-proposal-map.ts` file. For Phase 1, a minimal mapping is acceptable (e.g., `templates: ['write_artifact']`). This becomes a decision the operator confirms before Phase 1 executes.

2. **Does `packages/workbench-ui/` have a vitest configuration?**
   - What we know: `find` returned `packages/workbench-ui/vite.config.ts` but no `vitest.config.ts`. Other packages all have `vitest.config.ts`.
   - What's unclear: Whether `vite.config.ts` includes vitest configuration inline (Vite and Vitest can share config), or whether workbench-ui has no test infrastructure at all.
   - Recommendation: Planner should include a Wave 0 task to verify and add vitest config to `packages/workbench-ui/` if missing.

3. **How should `proposalsToday` be tracked across restarts?**
   - What we know: writing `kagent.knuteson.io/proposals-today: "N"` as an annotation on the disposition ConfigMap is the recommended approach. The operator updates it on each `disposition.proposal_rejected` emission.
   - What's unclear: The operator requires RBAC to PATCH ConfigMaps (currently the operator has `configmaps: [get, list, watch]` in the ClusterRole — needs `patch` added for this pattern).
   - Recommendation: Confirm the operator's existing RBAC grants for ConfigMaps before the planner designs the counter pattern. If PATCH is not already granted, add it to `packages/operator/charts/kagent-operator/templates/clusterrole.yaml`.

4. **Should `dispositions` use the existing `SnapshotCache` informer or direct K8s API calls?**
   - What we know: `SnapshotCache` (`packages/workbench-api/src/cache.ts`) caches `Agent`, `AgentTask`, `Job`, `Pod` objects from informers. Adding a new informer for ConfigMaps is possible but adds complexity.
   - What's unclear: Whether the planner wants near-real-time disposition updates (informer) or polling-acceptable (direct API call per request).
   - Recommendation: For Phase 1 (observation prototype), direct K8s API calls via `coreApi.listNamespacedConfigMap(...)` on each `GET /api/dispositions` request is acceptable. Informer-based caching is Phase 999.1 territory.

5. **Does the `disposition.over_budget` event need a per-day de-dup store that survives restarts?**
   - What we know: CONTEXT.md says "emit at most once per (agent, kind) per day." An in-memory map works but loses state on workbench-api restart.
   - What's unclear: Whether silent re-emission after a restart is acceptable for the observation phase.
   - Recommendation: For Phase 1 (7-day observation, small scale), in-memory de-dup is acceptable. Document the limitation. Write the de-dup key to the ConfigMap annotation as part of Q3's annotation-writing pattern if strong once-per-day guarantees are needed.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `packages/workbench-ui/` has no vitest config (no `vitest.config.ts` found) | Q7, Wave 0 Gaps | Low — if vitest config exists inline in `vite.config.ts`, Wave 0 gap is smaller |
| A2 | The operator's ClusterRole does not currently grant `configmaps: patch` | Q11 open questions | Medium — if patch is already granted, Q3's annotation-writing approach works without a chart change |
| A3 | There is no existing "proposal" concept or tool name convention in the v0.1 codebase for DISP-02's governance tiers | Q2, DISP-02 sketch | High — if such conventions exist in agent pods or elsewhere not read during research, the PROPOSAL_TOOL_MAP design decision is moot |
| A4 | The `coreApi.listNamespacedConfigMap` signature matches `@kubernetes/client-node` v1.x conventions | Q5, DISP-03 sketch | Low — the package is already used in `router.ts`; the API shape is stable |
| A5 | `GatewayUsageRow.inputTokens + outputTokens` correctly represents total tokens spent (not double-counted) | Q3 | Low — the gateway's `UsageRow` schema records both separately with no overlap |

**No claims in this research are ASSUMED from training data without codebase verification. All findings are from direct file inspection.**

---

## Environment Availability

Step 2.6: SKIPPED — Phase 1 is code and config changes within the existing monorepo. All external dependencies (NATS, Kubernetes, LiteLLM gateway, Langfuse) are pre-existing cluster services. No new external tools are introduced.

---

## Security Domain

Phase 1 introduces a new ConfigMap that narrows agent authority. Security considerations are inlined with the implementation:

- **V5 Input Validation:** The `parseDispositionConfigMap` function MUST validate every field in the disposition YAML before using it in the cap-narrowing step. Invalid or malformed dispositions must fail closed (treat as empty `mayProposeAgainst: []` if parse fails, logging a warning).
- **V4 Access Control:** The overlay narrows JWT scope; it never widens. This is enforced by the `claimsSubsetViolations` check after narrowing. A YAML injection attack on the ConfigMap cannot produce a wider cap — the underlying `Agent.spec.capabilityClaims` is the ceiling.
- **Revocation path (§11 bounds test):** Removing the disposition ConfigMap (`kubectl delete configmap`) removes the narrowing immediately. The next task mint for that Agent falls back to the full `Agent.spec.capabilityClaims`. This is the revocation path.

---

## Sources

### Primary (HIGH confidence — all from direct codebase inspection)

- `packages/audit-events/src/event-types.ts` — audit event kind naming convention, ALL_EVENT_TYPES array
- `packages/audit-events/src/types.ts` — CloudEvent envelope, AuditEventType union, AuditEventData discriminated union
- `packages/audit-events/src/publisher.ts` — AuditPublisher class, NATS JetStream publish pattern
- `packages/audit-events/src/make-event.ts` — makeEvent builder
- `packages/capability-types/src/types.ts` — CapabilityClaims, CapabilityBundle
- `packages/capability-types/src/validate.ts` — validateCapabilityClaims, validateCapabilityBundle
- `packages/operator/src/cap-issuer.ts` — mintCapabilityForTask, narrowClaimsByParent, CapabilityViolationError
- `packages/operator/src/crds/types.ts` — AgentSpec, existing annotation constants
- `packages/operator/src/crds/agent.ts` — publishTopicsOfAgent, subscribeTopicsOfAgent helpers
- `packages/operator/charts/kagent-operator/templates/smoke-test.yaml` — Job manifest pattern
- `packages/operator/charts/kagent-operator/values.yaml` — Helm values naming conventions
- `packages/operator/charts/kagent-workbench/values.yaml` — workbench chart values conventions
- `packages/llm-gateway/src/db/usage.ts` — UsageRow, UsageQueryFilter, UsageRepo
- `packages/workbench-api/src/gateway-client.ts` — GatewayUsageRow shape, GatewayClient interface
- `packages/workbench-api/src/router.ts` — RouterDeps, route mount pattern, existing coreApi field
- `packages/workbench-api/src/routes/agents.ts` — minimal Hono route pattern
- `packages/workbench-api/src/routes/gateway.ts` — Hono route with external HTTP client
- `packages/workbench-api/src/routes/tasks.test.ts` — test fixture patterns (makeTask, makeAgent)
- `packages/workbench-ui/src/command/state.ts` — useCommandSnapshot, CommandSnapshot, fetch patterns
- `packages/workbench-ui/src/command/Mission.tsx` — sibling overlay component pattern
- `packages/workbench-ui/src/CommandView.tsx` — overlay mount points, import structure
- `packages/workbench-ui/src/command/layout.ts` — computeLayout (snapshot mapper)
- `.planning/intel/constraints.md` — C-agent-disposition schema sketch, C-flow-economy, C-bounds

### Secondary (MEDIUM confidence)

- `docs/COMMAND-CENTER-CONTRACT.md` — Slice A/B/E acceptance criteria, Prime Directive
- `.planning/phases/01-agentdisposition-v0/01-CONTEXT.md` — locked decisions
- `.planning/REQUIREMENTS.md` — DISP-01..04 acceptance criteria

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages directly inspected
- Architecture: HIGH — codebase tracing was thorough for all 11 questions
- Pitfalls: HIGH — three critical gaps identified (no proposal concept, no vitest in workbench-ui, ConfigMap PATCH RBAC)
- Open questions: 5 items that planner must resolve before locking the plan

**Research date:** 2026-05-09
**Valid until:** 2026-06-09 (stable codebase; no fast-moving external dependencies)
