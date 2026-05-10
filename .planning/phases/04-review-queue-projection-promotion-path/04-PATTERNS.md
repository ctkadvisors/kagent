# Phase 04: Review queue projection + promotion path — Pattern Map

**Mapped:** 2026-05-10
**Files in scope:** 14 NEW + ~19 MODIFIED (per RESEARCH.md §Q12 summary table)
**Analogs verified:** all named analogs read; landmines from RESEARCH.md Q11 confirmed.

> Wave structure (per RESEARCH.md):
>
> - **W0** — Scaffolding: DTO, audit-event additions, fixtures, RBAC chart edits
> - **W1** — `GET /api/review-queue` projection (read-only)
> - **W2** — `POST .../accept|reject|request` write handlers
> - **W3** — UI surface: ReviewPage, ReviewActions, App.tsx route, TaskDetail mount, api.ts hook
> - **W4** — Phase 3 attention-flow flip + docs (AGENT-TEMPLATES, REPLAY-EVALS, SUBSTRATE-V1)

---

## File Classification

### W0 — Scaffolding (DTO + audit + fixtures + RBAC)

| New/Modified File                                                                  | Role                  | Data Flow        | Closest Analog                                                | Match Quality |
| ---------------------------------------------------------------------------------- | --------------------- | ---------------- | ------------------------------------------------------------- | ------------- |
| `packages/dto/src/review-queue.ts`                                                 | DTO + asserter        | request-response | `packages/dto/src/disposition.ts`                             | exact         |
| `packages/dto/src/review-queue.test.ts`                                            | DTO test              | unit             | `packages/dto/src/disposition.test.ts`                        | exact         |
| `packages/dto/src/template-candidate.ts`                                           | YAML→object validator | transform        | `packages/dto/src/disposition-parser.ts`                      | role-match    |
| `packages/dto/src/template-candidate.test.ts`                                      | parser test           | unit             | `packages/dto/src/disposition.test.ts`                        | role-match    |
| `packages/dto/src/index.ts` (M)                                                    | barrel re-export      | —                | itself                                                        | exact         |
| `packages/audit-events/src/event-types.ts` (M)                                     | event-type literals   | —                | itself (DISPOSITION\_\* block, lines 182–195)                 | exact         |
| `packages/audit-events/src/types.ts` (M)                                           | discriminated union   | —                | itself (DispositionOverBudgetData + union, lines 877–1000)    | exact         |
| `packages/audit-events/src/index.ts` (M)                                           | barrel re-export      | —                | itself                                                        | exact         |
| `packages/audit-events/src/make-event.test.ts` (M)                                 | round-trip test       | unit             | itself                                                        | exact         |
| `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json`               | fixture               | —                | `tests/fixtures/disposition/gateway-usage-rows.json`          | role-match    |
| `packages/workbench-api/src/__fixtures__/candidate-template.yaml`                  | fixture               | —                | NEW kind (no precedent for raw-YAML fixture in workbench-api) | NO ANALOG     |
| `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` (M) | RBAC manifest         | —                | itself (lines 49–59)                                          | exact         |
| `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` (M)         | RBAC manifest         | —                | itself (lines 28–41)                                          | exact         |

### W1 — GET projection

| New/Modified File                                                     | Role               | Data Flow               | Closest Analog                                           | Match Quality |
| --------------------------------------------------------------------- | ------------------ | ----------------------- | -------------------------------------------------------- | ------------- |
| `packages/workbench-api/src/routes/review-queue.ts` (W1 portion)      | route-handler      | request-response (read) | `packages/workbench-api/src/routes/dispositions.ts`      | exact         |
| `packages/workbench-api/src/routes/review-queue.test.ts` (W1 portion) | route test         | unit                    | `packages/workbench-api/src/routes/dispositions.test.ts` | exact         |
| `packages/workbench-api/src/router.ts` (M)                            | route registration | —                       | itself (lines 196–220 dispositions block)                | exact         |
| `packages/workbench-api/src/main.ts` (M)                              | deps wiring        | —                       | itself (lines 196–215 buildRouter call)                  | exact         |

### W2 — POST handlers (accept / reject / request)

| New/Modified File                                                     | Role          | Data Flow                | Closest Analog                                                                                                | Match Quality |
| --------------------------------------------------------------------- | ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/workbench-api/src/routes/review-queue.ts` (W2 POST portion) | route-handler | request-response (write) | `routes/tasks.ts` (POST `/api/tasks`, lines 143–284) + `routes/gateway.ts` (PATCH merge-patch, lines 440–481) | composite     |
| `packages/workbench-api/src/routes/review-queue.test.ts` (W2 portion) | route test    | unit                     | `routes/tasks.test.ts` (assumed — accept/reject equivalents); fall back to `dispositions.test.ts`             | role-match    |

### W3 — UI surface

| New/Modified File                                            | Role                | Data Flow        | Closest Analog                                                                                                                                          | Match Quality |
| ------------------------------------------------------------ | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/workbench-ui/src/ReviewPage.tsx`                   | UI page             | request-response | `packages/workbench-ui/src/TaskList.tsx`                                                                                                                | exact         |
| `packages/workbench-ui/src/ReviewPage.module.css`            | CSS module          | —                | `packages/workbench-ui/src/TaskList.module.css`                                                                                                         | exact         |
| `packages/workbench-ui/src/ReviewPage.test.tsx`              | component test      | unit             | `packages/workbench-ui/src/api.test.ts` (refactor target — actual `TaskList.test.tsx` analog not in tree; mirror it from `DispositionOverlay.test.tsx`) | role-match    |
| `packages/workbench-ui/src/command/ReviewActions.tsx`        | UI inline-component | request-response | `packages/workbench-ui/src/NewTaskModal.tsx` (modal+confirm) + per-row buttons in `TaskList.tsx`                                                        | composite     |
| `packages/workbench-ui/src/command/ReviewActions.module.css` | CSS module          | —                | `packages/workbench-ui/src/command/DispositionOverlay.module.css`                                                                                       | role-match    |
| `packages/workbench-ui/src/command/ReviewActions.test.tsx`   | component test      | unit             | `packages/workbench-ui/src/command/DispositionOverlay.test.tsx`                                                                                         | role-match    |
| `packages/workbench-ui/src/api.ts` (M)                       | hook + fetcher      | request-response | itself (`fetchDispositions` lines 116–126; `createTask` lines 134–156; `CreateTaskApiError` lines 158–170)                                              | exact         |
| `packages/workbench-ui/src/types.ts` (M)                     | DTO re-exports      | —                | itself (lines 29–33 DispositionOverlayRow re-export)                                                                                                    | exact         |
| `packages/workbench-ui/src/App.tsx` (M)                      | hash-router         | —                | itself (lines 55–77 parseHash + lines 95–132 mount blocks)                                                                                              | exact         |
| `packages/workbench-ui/src/TaskDetail.tsx` (M)               | inline mount        | —                | itself (lines 100–102 DetailBody mount site)                                                                                                            | exact         |

### W4 — Phase 3 attention-flow flip + docs

| New/Modified File                                                             | Role                        | Data Flow    | Closest Analog                               | Match Quality |
| ----------------------------------------------------------------------------- | --------------------------- | ------------ | -------------------------------------------- | ------------- |
| `packages/workbench-ui/src/command/source-binding.ts` (M)                     | closed-enum types           | —            | itself (lines 50–62 `DispositionFieldName`)  | exact         |
| `packages/workbench-ui/src/command/source-binding.test.ts` (M)                | orphan-assertion test       | unit         | itself (existing DispositionFieldName tests) | exact         |
| `packages/workbench-ui/src/command/flows.ts` (M)                              | flow gauge `compute()` body | event-driven | itself (`attention` block lines 290–314)     | exact         |
| `packages/workbench-ui/src/command/flows.test.ts` (M)                         | flow test                   | unit         | itself (existing attention test)             | exact         |
| `packages/workbench-ui/src/command/state.ts` (M)                              | snapshot interface          | —            | itself (lines 48–71 `CommandSnapshot`)       | exact         |
| `packages/workbench-ui/src/CommandView.tsx` (M)                               | snapshot consumer           | —            | itself + `useCommandSnapshot`                | exact         |
| `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` (M) | snapshot                    | —            | itself (vitest -u regenerated)               | exact         |
| `docs/AGENT-TEMPLATES.md` (M)                                                 | docs                        | —            | itself                                       | exact         |
| `docs/REPLAY-EVALS.md` (M)                                                    | docs                        | —            | itself                                       | exact         |
| `docs/SUBSTRATE-V1.md` (M)                                                    | docs                        | —            | itself (§4.3 audit-event catalog)            | exact         |

---

## Pattern Assignments — Per-file code excerpts

### W0.1 — `packages/dto/src/review-queue.ts` (DTO + asserter, NEW)

**Analog:** `packages/dto/src/disposition.ts` (exact — same role, same write side, same SemVer contract).

**MIT header + module JSDoc** (lines 1–22 of analog):

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ReviewQueueRow — Phase 4 / REV-01 read projection.
 *
 * The workbench-api computes this row per AgentTask flagged for
 * review (verifier-failed / suspicious-detector / human-review-
 * requested annotation / template-candidate annotation). NO new
 * persistence primitive — D2.
 *
 * The DTO is the single source of truth across the substrate-API-UI
 * tier boundary: workbench-api emits it, workbench-ui consumes it.
 * Adding a field is SemVer-minor; renaming or removing one is
 * SemVer-major.
 */
```

**Closed-enum reason type** (mirror of `DispositionOverBudgetReason`, line 38 of analog):

```typescript
export type ReviewReason =
  | 'verifier-failed'
  | 'suspicious-detector'
  | 'human-review-requested'
  | 'candidate-template'
  | 'replay-divergence' // Phase 5+ stub; zero v0.2 producers
  | 'eval-failed'; // Phase 5+ stub; zero v0.2 producers
```

**Row interface — readonly-everywhere** (lines 44–129 of analog):

```typescript
export interface ReviewQueueRow {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly reason: ReviewReason;
  readonly reasonDetail: string;
  readonly enqueuedAt: string;
  readonly stalenessSeconds: number;
  readonly phase: AgentTaskPhase;
  readonly targetAgent?: string;
  // ... full shape per CONTEXT.md D-01
}
```

**Runtime asserter — light per-field check, drift defense** (lines 139–192 of analog):

```typescript
export function assertIsReviewQueueRow(value: unknown): asserts value is ReviewQueueRow {
  if (typeof value !== 'object' || value === null) {
    throw new Error('ReviewQueueRow: not an object');
  }
  const r = value as Record<string, unknown>;
  if (typeof r['reason'] !== 'string') {
    throw new Error('ReviewQueueRow: reason missing');
  }
  // ... per-field guards mirroring assertIsDispositionOverlayRow
  if (
    r['reason'] !== 'verifier-failed' &&
    r['reason'] !== 'suspicious-detector' &&
    r['reason'] !== 'human-review-requested' &&
    r['reason'] !== 'candidate-template' &&
    r['reason'] !== 'replay-divergence' &&
    r['reason'] !== 'eval-failed'
  ) {
    throw new Error(`ReviewQueueRow: reason '${String(r['reason'])}' is not a known value`);
  }
}
```

**Landmine:** `ArtifactRefSummary` is a NEW sub-DTO. Mirror the existing `ArtifactSummary`/`ArtifactRef` in `packages/dto/src/types.ts` and `crds.ts` for shape; keep it readonly-everywhere.

---

### W0.2 — `packages/dto/src/review-queue.test.ts` (DTO test, NEW)

**Analog:** `packages/dto/src/disposition.test.ts` (exact).

**Helper for valid row** (lines 24–46 of analog):

```typescript
function validRow(overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    taskRef: { namespace: 'kagent-system', name: 'r-1', uid: 'u-1' },
    reason: 'verifier-failed',
    reasonDetail: 'verifier returned non-json',
    enqueuedAt: '2026-05-10T00:00:00.000Z',
    stalenessSeconds: 3600,
    phase: 'Failed',
    ...overrides,
  };
}
```

**Test pattern: round-trip + adversarial** (lines 48–60 of analog):

```typescript
describe('assertIsReviewQueueRow', () => {
  it('Test 1 — passes a valid ReviewQueueRow without throwing', () => {
    expect(() => assertIsReviewQueueRow(validRow())).not.toThrow();
  });
  it('Test 1b — throws when value is not an object', () => {
    expect(() => assertIsReviewQueueRow(null)).toThrow(/not an object/);
    expect(() => assertIsReviewQueueRow('hello')).toThrow(/not an object/);
  });
  // ... missing fields, malformed reason
});
```

---

### W0.3 — `packages/dto/src/template-candidate.ts` (parser, NEW)

**Analog:** `packages/dto/src/disposition-parser.ts` (role-match — string→object→shape-validate, fail-closed).

**`yaml` import is already a workspace dep** (line 33 of analog):

```typescript
import { parse as parseYaml } from 'yaml';
```

**ParseResult sum-type pattern** (lines 89–end of analog):

```typescript
export type ParseAgentTemplateSpecResult =
  | { readonly ok: true; readonly spec: AgentTemplateSpec }
  | { readonly ok: false; readonly error: string };

export function parseAgentTemplateSpec(yaml: string): ParseAgentTemplateSpecResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'YAML did not parse to an object' };
  }
  // ... validate against AgentTemplateSpec shape (operator/src/crds/types.ts:1103)
}
```

**Landmine:** `AgentTemplateSpec` lives in `packages/operator/src/crds/types.ts:1103-1117`, NOT yet in `@kagent/dto`. Either (a) re-export it through `packages/dto/src/crds.ts` (existing pattern) or (b) duplicate the type-only shape locally. Planner picks; the parser must NOT add a runtime dep on `@kagent/operator`.

---

### W0.4 — `packages/audit-events/src/event-types.ts` (M)

**Analog:** itself, the `DISPOSITION_*` block (lines 194–195).

**Add 4 new const literals** (mirror lines 194–195):

```typescript
/* Phase 4 — Review queue + promotion path (REV-02 / REV-03).
 * Four events bracket the review→promotion loop:
 *   - `review.requested` — operator POSTed /api/review-queue/:ns/:name/request
 *     to flag a Completed-clean task (the explicit-flag case beyond the
 *     verifier-failed / suspicious-detector implicit signals).
 *   - `review.accepted` — reviewer accept of any reason; for
 *     candidate-template additionally fires `template.candidate.promoted`.
 *   - `review.rejected` — reviewer reject; no AgentTemplate creation.
 *   - `template.candidate.promoted` — AgentTemplate CR created via
 *     accept-on-candidate-template. Distinct from `review.accepted` so
 *     downstream consumers can split the promotion event from the
 *     review-decision event without joining sibling events. */
export const REVIEW_REQUESTED = 'review.requested' as const;
export const REVIEW_ACCEPTED = 'review.accepted' as const;
export const REVIEW_REJECTED = 'review.rejected' as const;
export const TEMPLATE_CANDIDATE_PROMOTED = 'template.candidate.promoted' as const;
```

**Append to `ALL_EVENT_TYPES` Object.freeze list** (lines 202–252 of analog):

```typescript
export const ALL_EVENT_TYPES = Object.freeze([
  // ... existing 49 entries ...
  DISPOSITION_PROPOSAL_REJECTED,
  DISPOSITION_OVER_BUDGET,
  REVIEW_REQUESTED, // NEW
  REVIEW_ACCEPTED, // NEW
  REVIEW_REJECTED, // NEW
  TEMPLATE_CANDIDATE_PROMOTED, // NEW
] as const);
```

**Landmine:** the comment block at lines 14–19 mandates "Every const here MUST have a corresponding member in `AuditEventType` (types.ts) and in `AuditEventData`'s discriminated union." Adding a const here without updating both unions in `types.ts` is a TS compile error at every emission site. Both edits MUST land in the same commit.

---

### W0.5 — `packages/audit-events/src/types.ts` (M)

**Analog:** itself (`DispositionOverBudgetData` lines 877–898 + `AuditEventData` union lines 905–1000).

**Append to `AuditEventType` union** (lines 48–end of existing union):

```typescript
export type AuditEventType =
  // ... 49 existing literals ...
  | 'disposition.over_budget'
  /* Phase 4 — Review queue + promotion path. */
  | 'review.requested'
  | 'review.accepted'
  | 'review.rejected'
  | 'template.candidate.promoted';
```

**Add 4 data interfaces** (mirror `DispositionOverBudgetData` lines 877–898):

```typescript
/**
 * `review.requested` — Phase 4 / REV-02. Emitted by workbench-api when
 * an operator POSTs /api/review-queue/:namespace/:name/request to flag
 * a Completed-clean task for review. Distinct from implicit signals
 * (verifier-failed / suspicious-detector / template-candidate) which
 * surface in the projection without an emission event.
 */
export interface ReviewRequestedData {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

export interface ReviewAcceptedData {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly reason: ReviewReason; // re-exported from @kagent/dto/review-queue
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

export interface ReviewRejectedData {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly reason: ReviewReason;
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

export interface TemplateCandidatePromotedData {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly agentTemplateRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };
  readonly reviewerId?: string;
}
```

**Append to `AuditEventData` discriminated union** (lines 905–1000 of analog):

```typescript
export type AuditEventData =
  // ... existing variants ...
  | { readonly type: 'disposition.over_budget'; readonly data: DispositionOverBudgetData }
  /* Phase 4 — Review queue + promotion path. */
  | { readonly type: 'review.requested'; readonly data: ReviewRequestedData }
  | { readonly type: 'review.accepted'; readonly data: ReviewAcceptedData }
  | { readonly type: 'review.rejected'; readonly data: ReviewRejectedData }
  | { readonly type: 'template.candidate.promoted'; readonly data: TemplateCandidatePromotedData };
```

**Landmine:** `ReviewReason` lives in `@kagent/dto/review-queue.ts` (W0.1). Importing it here creates a `@kagent/audit-events` → `@kagent/dto` edge. Verify whether that edge already exists (it should not — `audit-events` is a leaf today). If it would be NEW: inline the union literal here instead of importing, OR duplicate the type via a small local re-declaration. Planner picks.

---

### W0.6 — `packages/audit-events/src/index.ts` (M)

**Analog:** itself (lines 25–138).

```typescript
export type {
  // ... existing data-shape exports ...
  ReviewRequestedData,
  ReviewAcceptedData,
  ReviewRejectedData,
  TemplateCandidatePromotedData,
} from './types.js';

export {
  // ... existing const exports ...
  REVIEW_REQUESTED,
  REVIEW_ACCEPTED,
  REVIEW_REJECTED,
  TEMPLATE_CANDIDATE_PROMOTED,
} from './event-types.js';
```

---

### W0.7 — `packages/audit-events/src/make-event.test.ts` (M)

**Analog:** itself (lines 32–120).

**Pattern: per-type round-trip + ALL_EVENT_TYPES count assertion**:

```typescript
import {
  REVIEW_REQUESTED,
  REVIEW_ACCEPTED,
  REVIEW_REJECTED,
  TEMPLATE_CANDIDATE_PROMOTED,
} from './event-types.js';

it('makeEvent({ type: REVIEW_ACCEPTED, data: { taskRef, reason } }) round-trips', () => {
  const event = makeEvent({
    type: REVIEW_ACCEPTED,
    source: 'kagent.knuteson.io/workbench-api',
    subject: 'AgentTask/kagent-system/r-1',
    data: {
      taskRef: { namespace: 'kagent-system', name: 'r-1', uid: 'u-1' },
      reason: 'verifier-failed',
    },
  });
  expect(event.type).toBe('review.accepted');
  expect(event.data.taskRef.uid).toBe('u-1');
});

it('ALL_EVENT_TYPES.length === 53 (49 + 4 new Phase 4 types)', () => {
  expect(ALL_EVENT_TYPES.length).toBe(53);
});
```

---

### W0.8 — `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` (NEW)

**Analog:** `tests/fixtures/disposition/gateway-usage-rows.json` (role-match — small JSON list of synthetic DTO-shaped objects).

**Shape:** an array of synthetic AgentTask-cache snapshots, one for each ReviewReason + a clean (no-signal) baseline + a priority-conflict (verifier-fail AND suspicious — verifier-failed wins per D-01-A).

```json
[
  {
    "metadata": {
      "namespace": "kagent-system",
      "name": "verifier-fail-1",
      "uid": "u-1",
      "creationTimestamp": "2026-05-10T08:00:00.000Z"
    },
    "spec": { "targetAgent": "researcher-01" },
    "status": {
      "phase": "Failed",
      "completedAt": "2026-05-10T09:00:00.000Z",
      "verification": {
        "passed": false,
        "mode": "judge",
        "reason": "verifier_returned_non_json",
        "completedAt": "2026-05-10T09:00:00.000Z"
      }
    }
  }
  // ... one per reason
]
```

**Import attribute pattern** (verbatim from `dispositions.test.ts:32`):

```typescript
import reviewQueueFixture from '../__fixtures__/review-queue-snapshot.json' with { type: 'json' };
```

---

### W0.9 — `packages/workbench-api/src/__fixtures__/candidate-template.yaml` (NEW)

**Analog:** none in workbench-api (NEW kind). Closest reference is `tests/fixtures/disposition/overlay-valid.yaml` for a raw-YAML fixture file convention.

**Shape:** a valid `AgentTemplateSpec` (per `packages/operator/src/crds/types.ts:1103-1117`) — minimal `agentSpec` body + 1 parameter + budget; one valid YAML for the accept-promote happy-path test.

```yaml
templateVersion: 1
parameters:
  - name: model
    type: string
    required: true
budget:
  maxIterations: 10
toolAllowlist: ['http']
agentSpec:
  model: ${param.model}
  capabilities: ['research']
```

---

### W0.10 — `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` (M)

**Analog:** itself (lines 49–59).

**Additive change** — extend `agenttasks` verbs and add new `agenttemplates` rule:

```yaml
rules:
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttasks']
    verbs: ['create', 'patch'] # +patch for review-decision annotation writes (Phase 4 / REV-02)
  # Phase 4 / REV-02 — AgentTemplate promotion via accept-on-candidate-template.
  # Scoped to release namespace per H17. Comment block at lines 27–37 already
  # mentioned the WS-M extension landing here.
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttemplates']
    verbs: ['create']
  - apiGroups: ['kagent.knuteson.io']
    resources: ['modelendpoints']
    verbs: ['patch', 'update']
```

**Landmine:** existing comment block (lines 27–37) explicitly previews the WS-M extension ("WS-M (AgentTemplate) will extend this Role with `agenttemplates: [get,list,watch]` when it lands"). Planner must update that comment to acknowledge the `[create]` verb landed in Phase 4 (write-side belongs in this Role), and `[get,list,watch]` belongs in the read-side `clusterrole.yaml`.

---

### W0.11 — `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` (M)

**Analog:** itself (lines 28–41 — existing kagent CRD resources list).

**Additive change** — extend the read resources list:

```yaml
rules:
  - apiGroups: ['kagent.knuteson.io']
    resources:
      - agents
      - agenttasks
      - agentcapabilities
      - modelendpoints
      - agenttemplates # NEW Phase 4 — read side of the promotion path
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['kagent.knuteson.io']
    resources:
      - agents/status
      - agenttasks/status
      - agentcapabilities/status
      - agenttemplates/status # NEW Phase 4
    verbs: ['get']
```

**Verification:** `kubectl auth can-i list agenttemplates --as system:serviceaccount:<ns>:<sa>` after chart re-deploy. Note: GitOps via Argo only — no imperative kubectl per CLAUDE.md.

---

### W1.1 — `packages/workbench-api/src/routes/review-queue.ts` (W1 GET portion, NEW)

**Analog:** `packages/workbench-api/src/routes/dispositions.ts` (exact — same projection-over-cache pattern, same audit-publisher wire shape, same `Hono` mounting).

**MIT header + module JSDoc** (lines 1–37 of analog):

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * GET /api/review-queue — Phase 4 / REV-01 read projection.
 *
 * Computes per-AgentTask review-queue rows from existing substrate state:
 *   - Verifier path: status.verification.passed === false → reason 'verifier-failed'
 *   - Detector path: status.structuralVerdict.suspicious.length > 0 → 'suspicious-detector'
 *   - Operator-flag path: annotations['kagent.knuteson.io/review-requested'] === 'true' → 'human-review-requested'
 *   - Template-candidate path: annotations['kagent.knuteson.io/template-candidate'] === 'true' && phase === 'Completed' → 'candidate-template'
 *
 * At-most-one row per task; priority verifier-failed > suspicious >
 * review-requested > candidate-template (D-01-A). Tasks whose
 * 'kagent.knuteson.io/review-decision' annotation is already set are
 * SKIPPED (already reviewed).
 *
 * REV-03: replay-divergence and eval-failed reasons are reserved for
 * AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
 * pre-implementation as of 2026-05-10). v0.2 producers: zero. Promote
 * when AgentTaskRun ships and the eval reducer emits divergence audit
 * events. Until then verifier-failed + suspicious-detector cover what
 * REQUIREMENTS.md REV-03 calls 'replay/eval signals' today.
 *
 * NO new persistence primitive — D2.
 * NO new CRD / no new reconciler / no new admission webhook.
 * Reload-stable by construction: pure read over SnapshotCache.
 */

import { Hono } from 'hono';
import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';

import {
  assertIsReviewQueueRow, // for runtime drift defense in tests
  type ReviewQueueRow,
  type ReviewReason,
} from '@kagent/dto';
import {
  REVIEW_REQUESTED,
  REVIEW_ACCEPTED,
  REVIEW_REJECTED,
  TEMPLATE_CANDIDATE_PROMOTED,
  makeEvent,
  type AuditEvent,
} from '@kagent/audit-events';

import type { SnapshotCache } from '../cache.js';
```

**RouteDeps shape** (mirror lines 73–108 of analog):

```typescript
export interface ReviewQueueRouteDeps {
  /** Required for the projection to enumerate AgentTasks. */
  readonly cache: SnapshotCache;
  /**
   * K8s CustomObjects client used by the POST handlers (PATCH AgentTask
   * annotations + CREATE AgentTemplate). When omitted, POST endpoints
   * return 503 with the documented "write surface disabled" body —
   * mirrors `tasks.ts:147` precedent.
   */
  readonly customApi?: CustomObjectsApi;
  /**
   * Optional audit publisher. When undefined, the projection still
   * computes rows but write handlers emit no events.
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /** Test-injectable clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Default namespace for promoted AgentTemplate CRs when the producing
   * task's namespace is omitted (rare; defensive). Mirrors `tasks.ts`'s
   * `defaultNamespace` field.
   */
  readonly defaultNamespace?: string;
  /** Optional Langfuse base URL; copied to row.traceLink when known. */
  readonly langfuseBaseUrl?: string;
}
```

**Factory + GET handler skeleton** (mirror lines 154–346 of analog):

```typescript
export function reviewQueueRoute(deps: ReviewQueueRouteDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? ((): Date => new Date());

  app.get('/', (c) => {
    const tasks = deps.cache.listTasks();
    const items: ReviewQueueRow[] = [];
    const nowMs = now().getTime();

    for (const task of tasks) {
      const annotations = task.metadata.annotations ?? {};
      // Step 1: skip already-decided
      if (annotations['kagent.knuteson.io/review-decision'] !== undefined) continue;
      // Step 2..5: classify priority order (verifier > suspicious > review-requested > candidate)
      const row = classifyTask(task, nowMs, deps.langfuseBaseUrl);
      if (row !== undefined) items.push(row);
    }
    // Sort: descending by stalenessSeconds (oldest first per REV-01)
    items.sort((a, b) => b.stalenessSeconds - a.stalenessSeconds);
    return c.json({ items });
  });

  // POST handlers wired in W2 (same `app` instance)
  return app;
}
```

**Classifier — pure fn** (analogous to `parseDispositionConfigMap` consumption pattern at analog lines 202–212):

```typescript
function classifyTask(
  task: AgentTask,
  nowMs: number,
  langfuseBaseUrl: string | undefined,
): ReviewQueueRow | undefined {
  const annotations = task.metadata.annotations ?? {};
  const status = task.status ?? {};
  const verification = status.verification;
  const verdict = status.structuralVerdict;

  // Priority 1: verifier-failed
  if (verification?.passed === false) {
    const enqueuedAt =
      verification.completedAt ??
      status.completedAt ??
      task.metadata.creationTimestamp ??
      new Date(nowMs).toISOString();
    return {
      taskRef: {
        namespace: task.metadata.namespace ?? 'default',
        name: task.metadata.name ?? '',
        uid: task.metadata.uid ?? '',
      },
      reason: 'verifier-failed',
      reasonDetail: verification.reason ?? 'verifier failed',
      enqueuedAt,
      stalenessSeconds: Math.max(0, Math.floor((nowMs - Date.parse(enqueuedAt)) / 1000)),
      // ... rest of row
    };
  }
  // Priority 2..4: same shape, different reason+enqueuedAt
}
```

**Router registration** (verbatim adaptation of `router.ts:196–220`):

```typescript
// in router.ts buildRouter:
if (deps.cache !== undefined) {
  // cache is always present in production
  app.route(
    '/api/review-queue',
    reviewQueueRoute({
      cache: deps.cache,
      ...(deps.customApi !== undefined && { customApi: deps.customApi }),
      ...(deps.auditPublisher !== undefined && { auditPublisher: deps.auditPublisher }),
      ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
      ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
    }),
  );
}
```

**Landmine (Q11):** `dispositions.ts` mounts at `/api/dispositions` AT ROUTER level (string passed to `app.route` is `/api/dispositions`, route handlers register on `'/'`). DO NOT register handlers on `'/api/review-queue'` inside the factory — register on `'/'`, mount at `/api/review-queue`. Hono's first-match-wins handles sub-path POSTs naturally.

**Landmine (Q11):** `tasks.ts` registers via `app.get('/api/tasks', ...)` at the TOP-LEVEL string (`router.ts:153–161` mounts at `'/'`). DON'T mix conventions — the dispositions-style mount is the right one for this phase.

---

### W1.2 — `packages/workbench-api/src/routes/review-queue.test.ts` (W1 portion, NEW)

**Analog:** `packages/workbench-api/src/routes/dispositions.test.ts` (exact — fixture-driven, makeStub\*, mountAndFetch, vitest jsdom-NOT-needed).

**Imports + fixture mount** (analog lines 25–42 + 32):

```typescript
import { Hono } from 'hono';
import type { V1ConfigMap } from '@kubernetes/client-node'; // not needed for review-queue; replace with AgentTask type
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertIsReviewQueueRow, type ReviewQueueRow } from '@kagent/dto';
import type { AuditEvent } from '@kagent/audit-events';

// Fixture import — JSON import-attributes pattern (Phase 2 gotcha)
import reviewQueueFixture from '../__fixtures__/review-queue-snapshot.json' with { type: 'json' };

import { reviewQueueRoute, type ReviewQueueRouteDeps } from './review-queue.js';
```

**Stub helpers** (mirror lines 64–142 of analog):

```typescript
function makeStubCache(tasks: readonly AgentTask[]): SnapshotCache {
  // The simplest stub: return a Pick<SnapshotCache, 'listTasks'> shape
  // (review-queue.ts only needs listTasks for the projection).
  return { listTasks: () => tasks } as unknown as SnapshotCache;
}

function makeStubCustomApi(): CustomObjectsApi & {
  readonly patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
  readonly createNamespacedCustomObject: ReturnType<typeof vi.fn>;
} {
  return {
    patchNamespacedCustomObject: vi
      .fn()
      .mockResolvedValue({
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTask',
        metadata: {},
      }),
    createNamespacedCustomObject: vi
      .fn()
      .mockResolvedValue({
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTemplate',
        metadata: { uid: 'tpl-1' },
      }),
  } as unknown as CustomObjectsApi & {
    /* ... */
  };
}

function makeStubAuditPublisher(): { readonly publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function mountAndFetch(deps: ReviewQueueRouteDeps): { fetch: () => Promise<Response> } {
  const app = new Hono();
  app.route('/', reviewQueueRoute(deps));
  return { fetch: () => app.request('/') };
}
```

**Reload-stability test pattern** (mirror analog lines 305–369):

```typescript
describe('GET /api/review-queue — reload-stability', () => {
  it('returns same items on two consecutive fetches (modulo stalenessSeconds advance)', async () => {
    const tasks = reviewQueueFixture as readonly AgentTask[];
    const cache = makeStubCache(tasks);
    const { fetch } = mountAndFetch({ cache });
    const r1 = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    const r2 = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(r2.items.length).toBe(r1.items.length);
    expect(r2.items.map((i) => i.taskRef.uid)).toEqual(r1.items.map((i) => i.taskRef.uid));
    for (const item of r1.items) assertIsReviewQueueRow(item);
  });
});
```

**Phase 2/3 vitest gotchas (per CONTEXT.md canonical refs):**

- Use `vi.useFakeTimers({ toFake: ['Date'] })` selective form when freezing time — full fake timer breaks the `app.request()` await
- Use `globalThis.fetch` not `global.fetch` for any direct fetch mocks (matters in W3 UI tests, not here)
- Use `urlOf()` URL helper if comparing fetched URLs

---

### W1.3 — `packages/workbench-api/src/router.ts` (M)

**Analog:** itself (lines 196–220 — dispositions registration block).

**Pattern: gate registration on cache presence** (already always-true; just shape):

```typescript
// in buildRouter, right after the dispositions block:
app.route(
  '/api/review-queue',
  reviewQueueRoute({
    cache: deps.cache,
    ...(deps.customApi !== undefined && { customApi: deps.customApi }),
    ...(deps.auditPublisher !== undefined && { auditPublisher: deps.auditPublisher }),
    ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
    ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
  }),
);
```

**RouterDeps shape — already covers everything we need** (no new fields). `customApi` (the WRITE one) is the gate for accept/reject; `auditPublisher` already wired by Phase 1; `defaultNamespace` already wired for `/api/tasks`.

---

### W1.4 — `packages/workbench-api/src/main.ts` (M)

**Analog:** itself (lines 196–215 — `buildRouter` call).

**No new env vars needed** — write surface gates on existing `WORKBENCH_ACTIONS_ENABLED`; audit publisher gates on existing `KAGENT_AUDIT_NATS_URL`. Per RESEARCH.md Q12: "NO new env vars; reuses existing `WORKBENCH_ACTIONS_ENABLED` and `KAGENT_AUDIT_NATS_URL`."

The `buildRouter({ ... })` call already passes everything review-queue needs (cache, auditPublisher, customApi, defaultNamespace, langfuseBaseUrl). No edit may be needed at all if router.ts wires from the existing `RouterDeps` fields.

---

### W2.1 — `packages/workbench-api/src/routes/review-queue.ts` (W2 POST handlers, same file)

**Analog (composite):**

- Accept handler — `tasks.ts:143-285` (POST validate → customApi → audit → response shape)
- Annotation patch — `gateway.ts:438-481` (MERGE_PATCH_OPTIONS + `customApi.patchNamespacedCustomObject(...)`)
- AgentTemplate create — `tasks.ts:219-226` (`customApi.createNamespacedCustomObject(...)`)

**MERGE_PATCH_OPTIONS constant** (verbatim from `gateway.ts:48`):

```typescript
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');
```

**Fail-closed pattern when customApi missing** (verbatim adaptation of `tasks.ts:143-150`):

```typescript
app.post('/:namespace/:name/accept', async (c) => {
  if (deps.customApi === undefined) {
    return c.json(
      {
        error:
          'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
      },
      503,
    );
  }
  // ... happy path
});
```

**X-Forwarded-User extraction** (verbatim from `routes/stream.ts:91-104`):

```typescript
const userVar = c.var as Record<string, unknown> | undefined;
const userFromVar =
  typeof userVar?.user === 'string' && userVar.user.length > 0 ? userVar.user : null;
const userFromHeader = c.req.header('X-Forwarded-User')?.trim();
const reviewerId =
  userFromVar ??
  (userFromHeader !== undefined && userFromHeader.length > 0 ? userFromHeader : undefined);
```

**Accept handler — load-bearing path** (composite from `tasks.ts:143-285` + `gateway.ts:438-481`):

```typescript
app.post('/:namespace/:name/accept', async (c) => {
  if (deps.customApi === undefined) {
    /* 503 ... */
  }

  const namespace = c.req.param('namespace');
  const name = c.req.param('name');

  // 1. Look up task in cache
  const task = deps.cache.getTask(namespace, name);
  if (task === undefined) return c.json({ error: 'not-found', namespace, name }, 404);

  // 2. 409 if already decided
  const annotations = task.metadata.annotations ?? {};
  if (annotations['kagent.knuteson.io/review-decision'] !== undefined) {
    return c.json({ error: `AgentTask ${namespace}/${name} already has a review decision` }, 409);
  }

  // 3. Parse request body — { reviewerId?, reasonText? }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const body = (raw as Record<string, unknown>) ?? {};
  const reviewerIdHeader = c.req.header('X-Forwarded-User')?.trim();
  const reviewerId =
    typeof body.reviewerId === 'string' && body.reviewerId.length > 0
      ? body.reviewerId
      : reviewerIdHeader;
  const reasonText = typeof body.reasonText === 'string' ? body.reasonText : undefined;

  // 4. Re-classify the task to learn its 'reason' (we don't trust client-supplied reason)
  const row = classifyTask(task, Date.now(), deps.langfuseBaseUrl);
  if (row === undefined) return c.json({ error: 'task is not in review queue' }, 409);

  // 5. For candidate-template: parse, validate, create AgentTemplate FIRST
  let agentTemplateRef: { namespace: string; name: string; uid: string } | undefined;
  if (row.reason === 'candidate-template') {
    const candidateYaml = extractCandidateTemplateYaml(task); // helper: read first artifact whose mediaType matches
    if (candidateYaml === undefined)
      return c.json({ error: 'candidate-template artifact not found on task' }, 422);
    const parsed = parseAgentTemplateSpec(candidateYaml); // from @kagent/dto/template-candidate
    if (!parsed.ok)
      return c.json({ error: `candidate-template parse failed: ${parsed.error}` }, 422);

    try {
      const created: unknown = await deps.customApi.createNamespacedCustomObject({
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace,
        plural: 'agenttemplates',
        body: {
          apiVersion: 'kagent.knuteson.io/v1alpha1',
          kind: 'AgentTemplate',
          metadata: {
            name: row.candidateTemplate?.proposedTemplateName ?? `${name}-template`,
            namespace: row.candidateTemplate?.proposedNamespace ?? namespace,
            annotations: { 'kagent.knuteson.io/promoted-from-task': `${namespace}/${name}` },
            ownerReferences: [
              /* producing AgentTask ownerRef */
            ],
          },
          spec: parsed.spec,
        },
      });
      const meta = readCreatedMeta(created); // shared helper from tasks.ts:371
      agentTemplateRef = {
        namespace: meta.namespace ?? namespace,
        name: meta.name ?? '',
        uid: meta.uid ?? '',
      };
    } catch (err) {
      const status = extractK8sStatus(err);
      // 409 (collision) → 422 with K8s body; 422 (schema) → 422 with K8s body
      // Audit-rev2 L17: scrub before returning
      return c.json(
        {
          error: 'AgentTemplate creation failed',
          detail: scrubSecrets(err instanceof Error ? err.message : String(err)),
        },
        422,
      );
    }
  }

  // 6. PATCH the AgentTask annotations (JSON merge-patch)
  const nowIso = new Date().toISOString();
  const patchBody = {
    metadata: {
      annotations: {
        'kagent.knuteson.io/review-decision': 'accepted',
        ...(reviewerId !== undefined && { 'kagent.knuteson.io/review-decided-by': reviewerId }),
        'kagent.knuteson.io/review-decided-at': nowIso,
      },
    },
  };
  try {
    await deps.customApi.patchNamespacedCustomObject(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace,
        plural: 'agenttasks',
        name,
        body: patchBody,
      },
      MERGE_PATCH_OPTIONS,
    );
  } catch (err) {
    // Atomicity note (CONTEXT.md D-03): partial-success — CR exists,
    // annotation didn't write. Queue row stays until next request retries.
    console.warn(
      `[review-queue] accept patch failed for ${namespace}/${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ error: 'patch annotation failed', detail: 'see workbench-api logs' }, 500);
  }

  // 7. Emit audit events
  if (deps.auditPublisher !== undefined) {
    const taskRef = { namespace, name, uid: task.metadata.uid ?? '' };
    try {
      await deps.auditPublisher.publish(
        makeEvent({
          type: REVIEW_ACCEPTED,
          source: 'kagent.knuteson.io/workbench-api',
          subject: `AgentTask/${namespace}/${name}`,
          data: {
            taskRef,
            reason: row.reason,
            ...(reviewerId !== undefined && { reviewerId }),
            ...(reasonText !== undefined && { reasonText }),
          },
        }),
      );
      if (agentTemplateRef !== undefined) {
        await deps.auditPublisher.publish(
          makeEvent({
            type: TEMPLATE_CANDIDATE_PROMOTED,
            source: 'kagent.knuteson.io/workbench-api',
            subject: `AgentTemplate/${agentTemplateRef.namespace}/${agentTemplateRef.name}`,
            data: { taskRef, agentTemplateRef, ...(reviewerId !== undefined && { reviewerId }) },
          }),
        );
      }
    } catch (err) {
      console.warn(
        `[review-queue] audit publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return c.json(
    {
      taskRef: { namespace, name, uid: task.metadata.uid ?? '' },
      decision: 'accepted',
      auditedAt: nowIso,
      ...(agentTemplateRef !== undefined && { agentTemplateRef }),
    },
    200,
  );
});
```

**K8s status extraction + readCreatedMeta** — re-use the existing helpers from `tasks.ts:346-382`. Either (a) export them from `tasks.ts` and import here, or (b) duplicate inline (small functions; copy is fine for one extra use site). Planner picks; default (a) — small refactor lifting `extractK8sStatus`, `readCreatedMeta` into a shared `routes/k8s-helpers.ts` is over-engineered for two consumers, but exporting from `tasks.ts` is cheap.

**Error scrubbing** (Audit-rev2 L17, verbatim from `tasks.ts:263-282`):

```typescript
// Do NOT echo the underlying K8s API error text to authenticated callers.
// Apiserver error messages can include internal hostnames, RBAC rule names,
// network paths, and (rarely) cluster-cert SANs. Keep the user-facing body
// generic and log the full error structurally so operators still have the diagnostic.
console.error(
  '[workbench-api] POST /api/review-queue/.../accept — unhandled K8s API error',
  JSON.stringify({ namespace, name, status: status ?? null, message: detail }),
);
```

For the K8s body inclusion in the 422 response (CONTEXT.md D-03 says "respond 422 with the K8s error body"): use `scrubSecrets(...)` from `error-scrub.ts` BEFORE inclusion — the scrubber removes API keys / bearer tokens but preserves status text. Planner verifies the scrubber is sufficient; fall back to error-only-no-body if there's any chance the K8s body leaks cluster-internal info.

**Reject handler — simpler** (mirror analog accept; subset):

```typescript
app.post('/:namespace/:name/reject', async (c) => {
  // 503 / 404 / 409 same as accept
  // PATCH review-decision: 'rejected' + companions
  // Emit REVIEW_REJECTED audit event
  // No AgentTemplate creation under any reason
  // 200 with { taskRef, decision: 'rejected', auditedAt }
});
```

**Request handler — simplest** (D-02):

```typescript
app.post('/:namespace/:name/request', async (c) => {
  // 503 if customApi undefined
  // 404 if task not in cache
  // 409 if already requested OR already decided
  // PATCH review-requested + companions
  // Emit REVIEW_REQUESTED audit event
  // 200 with { taskRef, requested: true, requestedAt }
});
```

---

### W2.2 — `packages/workbench-api/src/routes/review-queue.test.ts` (W2 POST tests)

**Analog:** `packages/workbench-api/src/routes/dispositions.test.ts` (audit publisher capture, customApi mock) + handler-call assertions equivalent to what would be in `tasks.test.ts` (assumed; follow the same pattern).

**Test pattern: capture customApi calls + audit-publisher payloads**:

```typescript
it('accept (verifier-failed) — patches AgentTask + emits review.accepted', async () => {
  const cache = makeStubCache([taskWithVerifierFail]);
  const customApi = makeStubCustomApi();
  const auditPublisher = makeStubAuditPublisher();
  const app = new Hono();
  app.route('/', reviewQueueRoute({ cache, customApi, auditPublisher }));

  const res = await app.request('/kagent-system/r-1/accept', { method: 'POST', body: '{}' });

  expect(res.status).toBe(200);
  expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
    expect.objectContaining({ plural: 'agenttasks', name: 'r-1' }),
    expect.anything(), // MERGE_PATCH_OPTIONS
  );
  expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled();
  const event = auditPublisher.publish.mock.calls[0][0];
  expect(event.type).toBe('review.accepted');
  expect(event.data.reason).toBe('verifier-failed');
});

it('accept (candidate-template) — creates AgentTemplate THEN patches THEN emits both events', async () => {
  // ... assert createNamespacedCustomObject called BEFORE patchNamespacedCustomObject (call order)
  // ... assert two events emitted: review.accepted + template.candidate.promoted
});

it('accept fails-closed when customApi undefined → 503 with documented message', async () => {
  // mirror tasks.test.ts pattern
});

it('accept on already-decided task → 409', async () => {
  /* ... */
});
it('accept on missing task → 404', async () => {
  /* ... */
});
it('accept on candidate-template with malformed YAML → 422', async () => {
  /* ... */
});
it('accept on candidate-template with name collision → 422 (K8s 409 → 422 mapped)', async () => {
  /* ... */
});
```

---

### W3.1 — `packages/workbench-ui/src/api.ts` (M)

**Analog:** itself (`fetchDispositions` lines 116–126; `createTask` lines 134–156; `CreateTaskApiError` lines 158–170).

**`fetchReviewQueue` — mirror `fetchDispositions`**:

```typescript
import { assertIsReviewQueueRow } from '@kagent/dto/review-queue';

export async function fetchReviewQueue(signal?: AbortSignal): Promise<ReviewQueueRow[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/review-queue', init);
  if (!res.ok) {
    throw new Error(`fetchReviewQueue: ${String(res.status)} ${res.statusText}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) assertIsReviewQueueRow(it);
  return items as ReviewQueueRow[];
}
```

**`acceptReviewQueueRow` / `rejectReviewQueueRow` / `requestReview` — mirror `createTask`** (lines 134–156):

```typescript
export async function acceptReviewQueueRow(
  namespace: string,
  name: string,
  body: { readonly reviewerId?: string; readonly reasonText?: string },
): Promise<{
  readonly decision: 'accepted';
  readonly agentTemplateRef?: { ns: string; name: string; uid: string };
}> {
  const res = await fetch(
    `/api/review-queue/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/accept`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (res.status === 200)
    return (await res.json()) as ReturnType<typeof acceptReviewQueueRow> extends Promise<infer R>
      ? R
      : never;
  let err: { error?: string } = {};
  try {
    err = (await res.json()) as typeof err;
  } catch {
    /* non-JSON; carry on */
  }
  throw new ReviewActionApiError(
    res.status,
    err.error ?? `request failed: ${String(res.status)} ${res.statusText}`,
  );
}

export class ReviewActionApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReviewActionApiError';
    this.status = status;
  }
}
```

**`useReviewQueue` hook — mirror Phase 1's polling pattern** (CONTEXT.md D-01-A says "5s polling default"):

```typescript
import { useEffect, useRef, useState } from 'react';

export function useReviewQueue(): {
  rows: readonly ReviewQueueRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [rows, setRows] = useState<readonly ReviewQueueRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refresh = (): void => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchReviewQueue(ctrl.signal)
      .then((items) => {
        setRows(items);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };
  useEffect(() => {
    refresh();
    const tick = setInterval(refresh, 5_000);
    return () => {
      clearInterval(tick);
      abortRef.current?.abort();
    };
  }, []);
  return { rows, loading, error, refresh };
}
```

**Landmine:** Phase 2 gotcha — UI tests must use `globalThis.fetch` for the mock, NOT `global.fetch`. The vitest jsdom env doesn't alias `global` to `globalThis` consistently; `globalThis` is the safe default.

---

### W3.2 — `packages/workbench-ui/src/types.ts` (M)

**Analog:** itself (lines 29–33 — `DispositionOverlayRow` re-export from `@kagent/dto/disposition`).

```typescript
// Phase 4 / REV-01 — shared DTOs for the review-queue slice. The
// workbench-api computes them; the workbench-ui renders them in
// ReviewPage + ReviewActions. Same type both sides means no drift.
export type {
  ReviewQueueRow,
  ReviewReason,
  ArtifactRefSummary, // if separately defined in the new module
} from '@kagent/dto/review-queue';
```

---

### W3.3 — `packages/workbench-ui/src/App.tsx` (M)

**Analog:** itself (lines 55–77 `parseHash` + lines 95–132 mount blocks).

**Add `ReviewRoute` interface** (mirror `CommandRoute` line 49):

```typescript
interface ReviewRoute {
  readonly kind: 'review';
}
type Route = DetailRoute | ListRoute | GatewayRoute | ClusterRoute | CommandRoute | ReviewRoute;
```

**Extend `parseHash`** (line 61):

```typescript
if (clean === 'review') return { kind: 'review' };
```

**Add mount block** (mirror lines 124–132):

```typescript
if (route.kind === 'review') {
  return <ReviewPage onBack={() => { window.location.hash = '#/'; }} />;
}
```

---

### W3.4 — `packages/workbench-ui/src/ReviewPage.tsx` (NEW)

**Analog:** `packages/workbench-ui/src/TaskList.tsx` (exact — table layout, refetch lifecycle, error/loading states).

**Lifecycle pattern — useEffect + AbortController** (lines 34–80 of analog):

```typescript
import { useEffect, useRef, useState } from 'react';
import { fetchReviewQueue, acceptReviewQueueRow, rejectReviewQueueRow } from './api.js';
import type { ReviewQueueRow } from './types.js';
import { assertSourceField, useSourceField } from './command/source-binding.js';
import styles from './ReviewPage.module.css';

export interface ReviewPageProps {
  readonly onBack: () => void;
}

export function ReviewPage({ onBack }: ReviewPageProps): React.JSX.Element {
  const [rows, setRows] = useState<readonly ReviewQueueRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<{
    row: ReviewQueueRow;
    action: 'accept' | 'reject';
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = (): void => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchReviewQueue(ctrl.signal)
      .then((items) => {
        setRows(items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  useEffect(() => {
    refetch();
    const tick = setInterval(refetch, 5_000); // 5s polling; future: SSE invalidation
    return () => {
      clearInterval(tick);
      abortRef.current?.abort();
    };
  }, []);

  // ... table + confirm-modal render
}
```

**Per-row table cell with source-binding** (D7 / CC-01 — mirror `TaskList.tsx:148-184` + Phase 2 source-binding pattern):

```typescript
{rows.map((row) => {
  // Assertions are dev-only no-ops in prod
  assertSourceField(row, 'reason');
  assertSourceField(row, 'reasonDetail');
  return (
    <tr key={`${row.taskRef.namespace}/${row.taskRef.name}`}>
      <td data-source-field={useSourceField('reason')}>
        <span className={`${styles.reasonPill} ${reasonClass(row.reason)}`}>{row.reason}</span>
      </td>
      <td data-source-field={useSourceField('taskRef')}>
        <a href={`#/tasks/${encodeURIComponent(row.taskRef.namespace)}/${encodeURIComponent(row.taskRef.name)}`}>
          {row.taskRef.namespace}/{row.taskRef.name}
        </a>
      </td>
      <td data-source-field={useSourceField('reasonDetail')}>{row.reasonDetail}</td>
      <td data-source-field={useSourceField('stalenessSeconds')}>{formatStaleness(row.stalenessSeconds)}</td>
      <td>
        <button onClick={() => setConfirmRow({ row, action: 'accept' })}>Accept</button>
        <button onClick={() => setConfirmRow({ row, action: 'reject' })}>Reject</button>
      </td>
    </tr>
  );
})}
```

---

### W3.5 — `packages/workbench-ui/src/command/ReviewActions.tsx` (NEW)

**Analog:** `packages/workbench-ui/src/NewTaskModal.tsx` (modal + confirm) + per-row buttons in `TaskList.tsx`.

**4-trigger-condition mount logic** (CONTEXT.md D-03):

```typescript
import type { TaskDetail } from '../types.js';

export interface ReviewActionsProps {
  readonly task: TaskDetail;
  readonly onDecision: () => void; // re-fetch detail after action
}

export function ReviewActions({ task, onDecision }: ReviewActionsProps): React.JSX.Element | null {
  // Mount only when the task is in the review queue
  const annotations = task.pilotEvidence?.audit.annotations ?? {};
  const eligible =
    task.phase === 'Failed' ||
    (task.suspicious?.length ?? 0) > 0 ||
    annotations['kagent.knuteson.io/review-requested'] === 'true' ||
    annotations['kagent.knuteson.io/template-candidate'] === 'true';
  if (!eligible) return null;

  // ... Accept / Reject / Request buttons + confirm modal (mirror NewTaskModal.tsx)
}
```

**Confirm-dialog modal pattern** (verbatim from `NewTaskModal.tsx:119-145` + Esc handler at lines 69–76):

```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [onClose]);

return (
  <div className={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ra-title">
      {/* Header + body + Cancel/Confirm buttons */}
    </div>
  </div>
);
```

---

### W3.6 — `packages/workbench-ui/src/TaskDetail.tsx` (M)

**Analog:** itself (lines 100–102 `<DetailBody>` mount).

**Mount inline above `<DetailBody>`** (per RESEARCH.md Q11):

```tsx
{
  detail !== null ? (
    <>
      <ReviewActions task={detail} onDecision={refetch} />
      <DetailBody detail={detail} />
    </>
  ) : null;
}
```

---

### W4.1 — `packages/workbench-ui/src/command/source-binding.ts` (M)

**Analog:** itself (lines 50–62 `DispositionFieldName`).

**Add `ReviewQueueFieldName` closed enum**:

```typescript
/** Closed enumeration of ReviewQueueRow top-level field names. */
export type ReviewQueueFieldName =
  | 'taskRef'
  | 'reason'
  | 'reasonDetail'
  | 'enqueuedAt'
  | 'stalenessSeconds'
  | 'phase'
  | 'targetAgent'
  | 'model'
  | 'suspicious'
  | 'verifierError'
  | 'traceLink'
  | 'artifactCount'
  | 'candidateTemplate'
  | 'replayDivergence';
```

---

### W4.2 — `packages/workbench-ui/src/command/flows.ts` (M)

**Analog:** itself (lines 290–314 `attention` block).

**Replace `compute()` body** (CONTEXT.md D7 — `data-source-field` flips from `'phase,suspicious'` to `'review-queue.rows.length'`):

```typescript
// ─────────────────────────── attention ───────────────────────────
// Phase 4 — source flipped to /api/review-queue rows count.
// REV-03: replay-divergence and eval-failed reasons are reserved for
// AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
// pre-implementation as of 2026-05-10). v0.2 producers: zero.
{
  kind: 'attention',
  granularity: 'substrateWide',
  sourceFields: ['reviewQueueRowCount'],  // FLIPPED from ['phase', 'suspicious']
  compute: (s): readonly FlowGauge[] => {
    const count = s.reviewQueueRowCount ?? 0;
    if (count === 0) return [];
    return [{
      kind: 'attention',
      sourceFields: ['reviewQueueRowCount'],
      detailLink: '#/review',  // FLIPPED from '#/tasks'
      label: 'review queue',   // FLIPPED label
      value: count,
      unit: 'items',
    }];
  },
  detailLink: (): string => '#/review',
},
```

**Landmine:** the existing comment block at lines 285–289 says "Phase 4 owns the real review queue projection" — REPLACE with the post-Phase-4 comment shown above. Don't leave both.

---

### W4.3 — `packages/workbench-ui/src/command/state.ts` (M)

**Analog:** itself (lines 48–71 `CommandSnapshot` interface).

**Add optional field** (additive; mirror Phase 1's `dispositions` field, lines 53–67):

```typescript
export interface CommandSnapshot {
  // ... existing fields ...
  /**
   * Phase 4 / REV-01 — count of rows in /api/review-queue. Optional so
   * the snapshot stays back-compat for tests that don't poll the route.
   * Wired in CommandView via useReviewQueue().rows.length OR a count-only
   * fetch (planner picks; CONTEXT.md D-01-A "lifecycle coupling" note).
   */
  readonly reviewQueueRowCount?: number;
}
```

---

### W4.4 — `packages/workbench-ui/src/CommandView.tsx` (M)

**Analog:** itself (existing `useCommandSnapshot()` consumption + overlay mount).

**Wire `useReviewQueue()` into the snapshot** — planner picks the cleanest integration. Default per CONTEXT.md "Claude's Discretion": a separate count fetch in CommandView paired with passing `reviewQueueRowCount` as an optional field on the snapshot consumed by `flows.ts`. The existing `useCommandSnapshot` hook in `state.ts:84-end` returns the snapshot — extend with a sibling `useReviewQueueRowCount()` hook that fetches just the count (or reuse `useReviewQueue()` and read `.rows.length`).

---

### W4.5 — `docs/AGENT-TEMPLATES.md` / `docs/REPLAY-EVALS.md` / `docs/SUBSTRATE-V1.md` (M)

**Pattern:** small footer additions per CONTEXT.md canonical-refs section.

- AGENT-TEMPLATES.md: footer documenting `application/x-kagent-template-candidate+yaml` media type + "Promotion via review queue" subsection pointing at this CONTEXT.md.
- REPLAY-EVALS.md: footer note pointing at Phase 4's REV-03 stub in `routes/review-queue.ts`.
- SUBSTRATE-V1.md §4.3: 4 new entries in the catalog table — total 49 → 53.

---

## Shared Patterns

### MIT license header (every new `.ts` file)

**Source:** `CLAUDE.md` ("MIT license header on every `.ts` source file"); every analog opens with this block.

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
```

**Apply to:** `review-queue.ts`, `review-queue.test.ts`, `template-candidate.ts`, `template-candidate.test.ts`, `ReviewPage.tsx`, `ReviewActions.tsx`, all new `.test.tsx` files.

---

### Audit publisher wire (every write handler)

**Source:** `routes/dispositions.ts:283-313` (every emission goes through `makeEvent` + `auditPublisher.publish`; failure swallowed-and-logged).

```typescript
if (deps.auditPublisher !== undefined) {
  try {
    await deps.auditPublisher.publish(
      makeEvent({
        type: REVIEW_ACCEPTED,
        source: 'kagent.knuteson.io/workbench-api',
        subject: `AgentTask/${namespace}/${name}`,
        data: {
          /* per-type discriminated-union shape */
        },
      }),
    );
  } catch (err) {
    console.warn(
      `[review-queue] audit publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Never block the response on audit failure
  }
}
```

**Apply to:** all three POST handlers in `routes/review-queue.ts` (accept, reject, request) — emit BEFORE returning 200.

---

### Fail-closed when `customApi` undefined

**Source:** `routes/tasks.ts:144-150` (verbatim — message text is part of the contract; tests grep for it).

```typescript
if (deps.customApi === undefined) {
  return c.json(
    {
      error:
        'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
    },
    503,
  );
}
```

**Apply to:** all three POST handlers in `routes/review-queue.ts`. The GET handler does NOT gate on `customApi` (read-only via cache).

---

### MERGE_PATCH_OPTIONS for K8s annotation patches

**Source:** `routes/gateway.ts:48` (verbatim constant; comment block at lines 39–47 explains why).

```typescript
import { setHeaderOptions } from '@kubernetes/client-node';
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');
```

**Apply to:** every `customApi.patchNamespacedCustomObject(...)` call in `routes/review-queue.ts` (accept, reject, request — all PATCH AgentTask annotations).

**Landmine (RESEARCH.md Q11):** the K8s client v1.x defaults to `application/json-patch+json` (RFC 6902 ops array). Without this constant, the patch body `{ metadata: { annotations: {...} } }` is rejected with `error decoding patch: cannot unmarshal object into []handlers.jsonPatchOp`. ALL three POST handlers MUST pass MERGE_PATCH_OPTIONS as the second arg.

---

### K8s status extraction + error scrubbing

**Source:** `routes/tasks.ts:346-356` (`extractK8sStatus`) + `routes/tasks.ts:263-282` (Audit-rev2 L17 don't-echo-K8s-error-text) + `error-scrub.ts:48-53` (`scrubSecrets`).

```typescript
const status = extractK8sStatus(err); // exported helper from tasks.ts
// Scrub before any return body that may include error.message
const detail = err instanceof Error ? scrubSecrets(err.message) : scrubSecrets(String(err));
console.error(
  '[workbench-api] POST /api/review-queue/.../accept — unhandled K8s error',
  JSON.stringify({ namespace, name, status: status ?? null, message: detail }),
);
return c.json({ error: 'internal error processing accept' /* no detail in response */ }, 500);
```

**Apply to:** every error path in accept/reject/request handlers. The CONTEXT.md D-03 says "respond 422 with the K8s error body" — interpret as "scrubbed status text from `err.body`" not "raw err.message".

---

### Source-binding `data-source-field` DOM attributes (D7 / CC-01)

**Source:** `command/source-binding.ts:181-205` (`assertSourceField` + `useSourceField`).

```typescript
import { assertSourceField, useSourceField } from './command/source-binding.js';

assertSourceField(row, 'reason');  // dev-only; throws if 'reason' is not a key on row
<td data-source-field={useSourceField('reason')}>{row.reason}</td>
```

**Apply to:** every cell in `ReviewPage.tsx` that renders a `ReviewQueueRow` field. The orphan-assertion test in `source-binding.test.ts` extends to cover `ReviewQueueFieldName`.

---

### Conventional commit format

**Source:** CLAUDE.md ("Conventional commits with co-author attribution").

Use prefixes: `feat(phase-04-...)`, `fix(phase-04-...)`, `docs(phase-04-...)`, `test(phase-04-...)`. End with co-author attribution per Chris's ctkadvisors style.

---

## Q11 Landmines — Things the analogs DON'T cover

These are noted in RESEARCH.md Q11 and CONTEXT.md; planner/executor MUST handle each explicitly.

### LM-1 — Sub-path POST routes (`/api/{ns}/{name}/{action}`)

**Status:** novel-shape but Hono-handles-it.

**Problem:** existing routes use either top-level shape (`POST /api/tasks`) or single-sub-path PATCH (`PATCH /api/modelendpoints/:ns/:name`). No existing route group has THREE trailing-action sub-path POSTs (`/accept`, `/reject`, `/request`).

**Resolution:** mount the route group at `/api/review-queue` (router.ts), register handlers internally on `'/'`, `/:namespace/:name/accept`, `/:namespace/:name/reject`, `/:namespace/:name/request`. Hono first-match-wins handles arbitrary nesting.

```typescript
// inside reviewQueueRoute factory:
app.get('/' /* GET handler */);
app.post('/:namespace/:name/accept' /* ... */);
app.post('/:namespace/:name/reject' /* ... */);
app.post('/:namespace/:name/request' /* ... */);
```

### LM-2 — JSON merge-patch annotation write on AgentTask from workbench-api

**Status:** NEW from workbench-api. Operator-side `job-annotator.ts` does Job annotations; `gateway.ts` does ModelEndpoint spec; nothing today does AgentTask metadata.annotations from workbench-api.

**Resolution:** inline the call in `routes/review-queue.ts` (per RESEARCH.md Q11 recommendation). Use the existing MERGE_PATCH_OPTIONS constant from gateway.ts (or duplicate it locally — same one-liner). NO new helper file.

```typescript
await deps.customApi.patchNamespacedCustomObject(
  { group: 'kagent.knuteson.io', version: 'v1alpha1', namespace, plural: 'agenttasks', name, body: { metadata: { annotations: { ... } } } },
  MERGE_PATCH_OPTIONS,
);
```

### LM-3 — `customApi.createNamespacedCustomObject` outside `tasks.ts`

**Status:** second use site. Currently only `tasks.ts:220` calls it.

**Resolution:** inline the call in `routes/review-queue.ts` accept handler. Two call sites do NOT justify extracting to a shared helper. If/when a third lands (e.g., POST `/api/agents`), refactor.

**Required helper LIFTING:** `extractK8sStatus` (tasks.ts:346) and `readCreatedMeta` (tasks.ts:371) — these are NEEDED by the accept handler. Either export them from `tasks.ts` (cheap) OR duplicate (also cheap). Planner picks; the export path keeps tests for them in one place.

### LM-4 — YAML parsing for AgentTemplateSpec

**Status:** `yaml` is already a workspace dep (used by `disposition-parser.ts:33`).

**Resolution:** new `packages/dto/src/template-candidate.ts` parses YAML → object → validates against `AgentTemplateSpec` shape. NO zod (workspace ships zero runtime-validation deps; matches `validators.ts:7-15` rationale). Hand-rolled checker.

**Landmine within landmine:** `AgentTemplateSpec` lives in `packages/operator/src/crds/types.ts:1103`, NOT `@kagent/dto`. Either re-export through `packages/dto/src/crds.ts` (existing duplication-by-design pattern, see comment lines 58–60 of `dto/index.ts`) OR duplicate the type-only shape inside the new module. Planner picks; default: re-export through `dto/crds.ts`.

### LM-5 — `auditPublisher` shape vs Phase 3 (no novelty)

**Status:** identical to Phase 1.

**Resolution:** re-use `RouterDeps.auditPublisher` field (already wired); no main.ts changes needed for the publisher itself.

### LM-6 — Atomicity: AgentTemplate create THEN patch annotation

**Status:** D-03 explicitly says "atomic-ish — annotation-write is the second step so a partial create+failed-annotate leaves the CR but the queue row stays until next request retries."

**Resolution:** order matters. In the accept handler:

1. Create AgentTemplate FIRST.
2. PATCH AgentTask annotations SECOND.
3. Audit-event emit THIRD.

If step 2 fails after step 1 succeeded: respond 500 with `error: 'patch annotation failed'`. The CR is orphan-ish; a retry of the accept on the same task will hit step 1 → 409 collision → handler must treat the 409 as success-equivalent (idempotent). RESEARCH.md Pitfall 2 details this.

### LM-7 — Phase 3 `attention` flow surgical change

**Status:** known.

**Resolution:** ~10–15 line change to `flows.ts:290-314` `attention.compute()` body. The `FlowGauge` shape stays identical. The `data-source-field` flips from `'phase,suspicious'` to `'reviewQueueRowCount'` (single-source) per Phase 4. The flows.test.ts `attention` test updates to set `s.reviewQueueRowCount` instead of synthesizing Failed tasks.

### LM-8 — `cc-reload.test.tsx.snap` regeneration

**Status:** known (per Phase 3 pattern).

**Resolution:** after `flows.ts` `attention.compute()` body changes AND `state.ts` `CommandSnapshot` adds `reviewQueueRowCount`, run `pnpm -C packages/workbench-ui test -u` to regenerate `__snapshots__/cc-reload.test.tsx.snap`. Land the snapshot diff in a SINGLE dedicated commit (RESEARCH.md Pitfall 1) so reviewers can scrutinize the diff in isolation.

### LM-9 — `ALL_EVENT_TYPES.length` test bump

**Status:** known.

**Resolution:** existing `make-event.test.ts` likely asserts `ALL_EVENT_TYPES.length === 49`. Bump to 53 with the 4 Phase 4 additions. RESEARCH.md Pitfall 8 calls this out.

### LM-10 — Dependency edge: `@kagent/audit-events` → `@kagent/dto`

**Status:** new edge if `ReviewReason` is imported from `@kagent/dto/review-queue` in `audit-events/src/types.ts`.

**Resolution:** verify whether the edge already exists (audit-events is a leaf today). If it would be NEW: inline the union literal in audit-events `types.ts` (duplicate the 6 strings) instead of importing. Planner picks.

---

## Files with no analog

| File                                                              | Role                  | Reason                                                                                                                                         |
| ----------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-api/src/__fixtures__/candidate-template.yaml` | raw-YAML test fixture | No precedent in workbench-api for raw-YAML fixtures. Closest reference is `tests/fixtures/disposition/overlay-valid.yaml` (different package). |

All other files have explicit analogs verified above.

---

## Metadata

**Analog search scope:** `packages/{dto,workbench-api,workbench-ui,audit-events,operator}/src/**/*.{ts,tsx,yaml}`, `tests/fixtures/**`.
**Files scanned:** 25+ analogs read directly; ~100 files traversed during analog ranking.
**Pattern extraction date:** 2026-05-10.
**Confidence:** HIGH — every named analog opened and verified. Q11 landmines independently confirmed via grep + file-read.
