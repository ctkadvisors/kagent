---
phase: 04-review-queue-projection-promotion-path
reviewed: 2026-05-10T00:00:00Z
depth: standard
files_reviewed: 35
files_reviewed_list:
  - packages/dto/src/review-queue.ts
  - packages/dto/src/review-queue.test.ts
  - packages/dto/src/template-candidate.ts
  - packages/dto/src/template-candidate.test.ts
  - packages/dto/src/index.ts
  - packages/audit-events/src/event-types.ts
  - packages/audit-events/src/types.ts
  - packages/audit-events/src/index.ts
  - packages/audit-events/src/make-event.test.ts
  - packages/workbench-api/src/__fixtures__/review-queue-snapshot.json
  - packages/workbench-api/src/__fixtures__/candidate-template.yaml
  - packages/workbench-api/src/router.ts
  - packages/workbench-api/src/routes/review-queue.ts
  - packages/workbench-api/src/routes/review-queue.test.ts
  - packages/workbench-api/src/routes/tasks.ts
  - packages/workbench-ui/src/types.ts
  - packages/workbench-ui/src/api.ts
  - packages/workbench-ui/src/api.test.ts
  - packages/workbench-ui/src/App.tsx
  - packages/workbench-ui/src/ReviewPage.tsx
  - packages/workbench-ui/src/ReviewPage.test.tsx
  - packages/workbench-ui/src/TaskDetail.tsx
  - packages/workbench-ui/src/CommandView.tsx
  - packages/workbench-ui/src/command/ReviewActions.tsx
  - packages/workbench-ui/src/command/ReviewActions.test.tsx
  - packages/workbench-ui/src/command/source-binding.ts
  - packages/workbench-ui/src/command/source-binding.test.ts
  - packages/workbench-ui/src/command/state.ts
  - packages/workbench-ui/src/command/flows.ts
  - packages/workbench-ui/src/command/flows.test.ts
  - packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap
  - packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml
  - packages/operator/charts/kagent-workbench/templates/clusterrole.yaml
  - docs/AGENT-TEMPLATES.md
  - docs/REPLAY-EVALS.md
  - docs/SUBSTRATE-V1.md
findings:
  critical: 3
  warning: 8
  info: 5
  total: 16
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-05-10
**Depth:** standard
**Files Reviewed:** 35
**Status:** issues_found

## Summary

Phase 4 ships the review-queue projection (`GET /api/review-queue`), the
3-action write surface (`POST .../accept|reject|request`), the candidate-template
promotion path, four new audit-event types, the `ReviewPage` SPA route, the inline
`ReviewActions` panel for `TaskDetail`, and the RBAC + CC-01 / D7 source-binding
plumbing.

The high-leverage spec controls reviewers asked me to confirm hold up:

- The 5-step accept order in `routes/review-queue.ts` IS correct: 503 → 404 → 409 →
  body-parse → re-classify → CR-create (candidate only) → annotation-patch → audit
  events → 200. CR creation precedes annotation patch (D-03 atomicity).
- Fail-closed behavior (`customApi === undefined` → 503 with verbatim
  `tasks.ts:147` message) is enforced on all three POST handlers, no audit emission.
- Audit discipline is correct: `template.candidate.promoted` only fires when the
  AgentTemplate CR creation succeeds AND we're on the `candidate-template` reason.
  The K8s 409-collision test (`W2-Test 7`) proves no events fire on early return.
- RBAC additivity: `clusterrole-actions.yaml` adds `agenttasks:[patch]` and
  `agenttemplates:[create]`; `clusterrole.yaml` adds `agenttemplates`+
  `agenttemplates/status` reads. No verbs were removed.
- `ReviewQueueFieldName` correctly enumerates 14 keys; the closed-enum is
  exercised by `source-binding.test.ts` Test M.
- Reload-stability is established for the GET projection (`Test 12`). The
  `SnapshotCache` access path is pure-read.
- MIT license headers are present on every new `.ts` / `.tsx` file in scope.

However, **three Critical defects materially break expectations the spec sets**, plus
several Warning-tier correctness/quality issues. Highlights:

- **CR-01 (BLOCKER):** Annotation-patch failure after a successful AgentTemplate
  CR creation returns a 500 to the operator while the substrate is in an inconsistent
  state — the AgentTemplate exists, but no `review-decision: accepted` annotation,
  no audit events emitted. A retry the operator triggers will hit the K8s 409 on
  CR creation and emit a 422 — the audit log NEVER records the actual promotion.
- **CR-02 (BLOCKER):** Spec mismatch — `ReviewQueueRow.candidateTemplate.proposedTemplateName`
  ignores the `kagent.knuteson.io/proposed-template-name` annotation **in the accept
  handler** even though the GET classifier honors it. The accept handler reads
  `row.candidateTemplate?.proposedTemplateName` (which DID resolve the annotation
  on classifier path) — but the fallback is `${name}-template`, NOT the annotation
  value. The result name actually agrees, but `reasonDetail` in classifier on line 900
  is "candidate AgentTemplate from {ns}/{name}" — which directly contradicts
  `review-queue.ts:85` JSDoc spec ("`proposedTemplateName + ' (candidate)'`") AND
  `review-queue.test.ts:230` expects the URI string but never asserts the spec
  format. Tests pass because they don't enforce the spec.
- **CR-03 (BLOCKER):** Audit-event schema-vs-test mismatch. `ReviewAcceptedData.reason`
  is typed as a 6-member union including `replay-divergence` and `eval-failed` (LM-10
  inline copy, types.ts:951-957) — but the catalog doc and Phase 4 spec carry only
  4 producer-active reasons. If a future v0.3 producer emits one of the two stub
  reasons through the accept path, the `reason` field IS valid by type but `ReviewReason`
  in `@kagent/dto/review-queue.ts` already promises `eval-failed`/`replay-divergence`
  are zero-producer in v0.2. This is structurally sound but the inline duplication
  per LM-10 means a rename in `@kagent/dto` will silently desync the audit-event
  shape. Adversarial: try renaming `'verifier-failed'` to `'verifier_failed'` in
  `dto/review-queue.ts` and `tsc` won't catch the drift in `audit-events/types.ts:951`.
  See finding for the concrete trap.

In addition, eight Warning-class findings cover: a missing `agentTemplateRef` shape
when CR creation succeeded but `metadata.{name,namespace}` was malformed (would
serialize empty strings); a 422 substring mismatch between test expectation and
actual error string; the GET handler `langfuseBaseUrl` re-derivation that doesn't
match `dto/traceLink()`; missing `verifierError` propagation when a verifier-failed
classifier resolves with `verification.reason === undefined`; missing 'replay-divergence' reason
in `reasonClass()` switch falls through to default but the field is reachable via type;
the candidate-template GET classifier loops over `task.status?.artifacts` without
bounds check on payloadBase64 size which could be arbitrarily large; the 503
fail-closed for the request handler returns the same message but the message
documents `actions.create=true` whereas request needs only `agenttasks:[patch]`;
and the API helper's error body parsing in `acceptReviewQueueRow` swallows the
422 `detail` field (only reads `error`).

## Critical Issues

### CR-01: Annotation-patch failure after successful AgentTemplate CR create leaves substrate inconsistent and unaudited

**File:** `packages/workbench-api/src/routes/review-queue.ts:349-375`
**Issue:**
The candidate-template happy path is:

1. CR is created via `createNamespacedCustomObject` (lines 313–319). On success, `agentTemplateRef` is captured (line 320).
2. Annotation patch via `patchNamespacedCustomObject` (lines 351–369).
3. Audit events emitted (lines 378–431).

If the patch in step 2 fails (transient apiserver 500, network blip, RBAC race),
the handler returns a 500 (line 374) — but neither `review.accepted` nor
`template.candidate.promoted` is published. The cluster state is now inconsistent:

- The AgentTemplate CR exists.
- The AgentTask has no `review-decision` annotation, so it remains in the queue.
- A retry by the operator hits the 409 path (line 333) because the CR already
  exists, returns 422, and STILL emits no audit events.

The audit log permanently lacks any record of the AgentTemplate creation that
actually happened. Spec call-out (file header line 195: "8. Emit audit events
(best-effort; swallow-and-log per dispositions.ts precedent)") promises events
fire when the CR exists, but the order forecloses them.

**Fix:**
Three options, ranked by safety:

1. (Preferred) Emit `template.candidate.promoted` as soon as the CR is created (between current line 320 and the patch attempt). Keep `review.accepted` after patch success. The promotion event is the truthful audit record of the CR existing; downstream replay tools can reconcile by joining promotion event with eventual `review.accepted`.

2. Emit BOTH events on the patch-failure path before returning 500. Trade-off: an event with a "decision" semantic when the annotation didn't actually land — confusing if reviewers debug from audit alone.

3. Swap the patch and event order — emit `template.candidate.promoted` first, then patch, then 200. Still leaves a window for the `review.accepted` event being missed if the patch fails after the promoted event lands.

```typescript
// Step 7' — emit template.candidate.promoted IMMEDIATELY after CR creation
//          (before patch). Records that the substrate created the CR; audit
//          consumers can join to review.accepted once it later fires.
if (row.reason === 'candidate-template' && agentTemplateRef !== undefined && deps.auditPublisher !== undefined) {
  try {
    await deps.auditPublisher.publish(makeEvent({
      type: TEMPLATE_CANDIDATE_PROMOTED,
      source: 'kagent.knuteson.io/workbench-api',
      subject: `AgentTask/${namespace}/${name}`,
      data: { taskRef, agentTemplateRef: { ... }, reviewerId },
    }));
  } catch (err) { logWarn(...); }
}

// Step 7 — annotation patch (existing code follows)
```

Add a test that exercises a successful create + failed patch: assert
`template.candidate.promoted` was published before the 500 returned.

---

### CR-02: Classifier `reasonDetail` for candidate-template contradicts the documented spec format

**File:** `packages/dto/src/review-queue.ts:85` and `packages/workbench-api/src/routes/review-queue.ts:900`
**Issue:**
`review-queue.ts:85` JSDoc on the DTO field declares the structured format:

```
- candidate-template: proposedTemplateName + ' (candidate)'
```

The classifier in `routes/review-queue.ts:900` actually produces:

```typescript
const reasonDetail = `candidate AgentTemplate from ${proposedNamespace}/${name}`;
```

This is a different string. Three downstream consequences:

1. UI tests (`ReviewPage.test.tsx`) and CC-01 source-binding rely on the DTO
   contract; the spec drift means the rendered "Reason Detail" cell carries
   "candidate AgentTemplate from kagent-system/researcher-task-01" instead of
   the documented "researcher-template-v2 (candidate)".
2. The audit-event reason data carries the same sloppy detail by reference.
3. `review-queue.test.ts` Test 6 (line 233) asserts `proposedTemplateName.length > 0`
   without enforcing the formatted shape — the test passes on a misimplemented
   classifier.

This is a Critical because the DTO contract is the substrate-API-UI tier-boundary
spec. Either the spec or the implementation is wrong; in either case the contract
is broken.

**Fix:**
Align with the DTO spec by changing the classifier output:

```typescript
// routes/review-queue.ts:900
const reasonDetail = `${proposedTemplateName} (candidate)`;
```

Or, if the verbose form is intentionally chosen for human readability, update
the DTO JSDoc on `dto/review-queue.ts:85` to match. Then add a regression test
to `review-queue.test.ts` Test 6:

```typescript
expect(body.items[0]?.reasonDetail).toBe(
  `${row.candidateTemplate?.proposedTemplateName ?? ''} (candidate)`,
);
```

---

### CR-03: `ReviewAcceptedData.reason` and `ReviewRejectedData.reason` inline-copy `ReviewReason` from `@kagent/dto`; no compile-time sync check

**File:** `packages/audit-events/src/types.ts:940-960` and `:966-982`
**Issue:**
LM-10 motivates the inline copy: `@kagent/audit-events` is a leaf package and
shouldn't take a workspace-dep on `@kagent/dto`. Sound reasoning; the implementation
is what bites. Both `ReviewAcceptedData.reason` and `ReviewRejectedData.reason`
are typed as a 6-member string-literal union duplicating `ReviewReason`:

```typescript
readonly reason:
  | 'verifier-failed'
  | 'suspicious-detector'
  | 'human-review-requested'
  | 'candidate-template'
  | 'replay-divergence'
  | 'eval-failed';
```

Three drift modes are silent:

1. Renaming `'verifier-failed'` → `'verifier_failed'` in `dto/review-queue.ts`
   compiles cleanly because the audit-events package doesn't import the dto
   union. The accept handler call site `data: { ..., reason: row.reason }` then
   produces a TS error in workbench-api — but only there, not in the audit-events
   package itself.
2. Adding a new ReviewReason member only to `dto` (e.g., `'policy-divergence'`):
   the call-site cast at `routes/review-queue.ts:387` (`reason: row.reason`)
   compiles to a structural-narrowing error caught by `tsc`, BUT only at the
   point of emission. The audit-events `data` shape is now structurally narrower
   than what the substrate produces. A downstream consumer with the old union
   will see undefined behavior at runtime.
3. Removing a member from the dto without removing it from audit-events: a
   call site with the old `row.reason === 'eval-failed'` literal compiles fine
   in audit-events — even though no producer can emit it.

There is no exhaustiveness test linking the two unions. Adding one is mechanical:

```typescript
// audit-events/src/types.test.ts
import type { ReviewReason } from '@kagent/dto/review-queue';
import type { ReviewAcceptedData } from './types.js';
// Phase 4 LM-10: ReviewAcceptedData.reason MUST equal ReviewReason structurally.
const _check1: ReviewReason = '' as unknown as ReviewAcceptedData['reason'];
const _check2: ReviewAcceptedData['reason'] = '' as unknown as ReviewReason;
```

This is a `type-only import` — not a runtime workspace dep, doesn't violate LM-10.

**Fix:**
Add the type-only cross-check above as a sibling test or to the package-shared
types-test file. This is a one-line guard that surfaces a `tsc` failure on any
desync.

Alternative: collapse to a single re-exported type. `audit-events` already
type-imports from external packages (e.g., `@kubernetes/client-node`'s namespace
types). A type-only `import type { ReviewReason } from '@kagent/dto/review-queue';`
plus assignment of `reason: ReviewReason` does NOT add a runtime dep edge; the
LM-10 constraint is on runtime deps, and `tsc --emit` strips type-only imports.
Re-evaluate the LM-10 rule scope.

## Warnings

### WR-01: `agentTemplateRef` returned from accept handler can carry empty-string namespace/name when K8s response is malformed

**File:** `packages/workbench-api/src/routes/review-queue.ts:402-408` and `tasks.ts:377-388`
**Issue:**
`readCreatedMeta()` returns `{}` when the K8s response is structurally invalid:

```typescript
// tasks.ts:378
if (obj === null || typeof obj !== 'object') return {};
```

The accept handler then constructs:

```typescript
// review-queue.ts:404-408
const promotedRef = {
  namespace: agentTemplateRef.namespace ?? '',
  name: agentTemplateRef.name ?? '',
  uid: agentTemplateRef.uid,
};
```

Both `namespace` and `name` default to empty strings. The `template.candidate.promoted`
audit event will then carry `{ namespace: '', name: '', uid: undefined }` — a
useless join key for downstream consumers. The HTTP 200 response also serializes
this empty-string ref in the `agentTemplateRef` body (line 438).

**Fix:**
After `agentTemplateRef = readCreatedMeta(created)`, assert at minimum
`agentTemplateRef.name !== undefined && agentTemplateRef.namespace !== undefined`.
On miss, log structured + return 500 (the K8s response was malformed; we have no
way to record the audit event accurately). Alternatively, fall back to the
request's `proposedTemplateName` / `proposedNamespace` since those values are
what we asked the server to create.

```typescript
agentTemplateRef = readCreatedMeta(created);
if (agentTemplateRef.name === undefined || agentTemplateRef.namespace === undefined) {
  logError(
    `[workbench-api] AgentTemplate created but K8s response missing metadata.{name,namespace}`,
  );
  // fall back to request values since we know what we sent
  agentTemplateRef = {
    name: proposedTemplateName,
    namespace: proposedNamespace,
    ...(agentTemplateRef.uid !== undefined && { uid: agentTemplateRef.uid }),
  };
}
```

### WR-02: 422 error body uses verbose error string but tests only assert weak substring matches

**File:** `packages/workbench-api/src/routes/review-queue.ts:292, 334, 374` and `routes/review-queue.test.ts:840`
**Issue:**
The handler returns several 422 bodies with distinctive `error`+`detail` shapes:

- `'candidate-template parse failed'` + `detail: parsed.error` (line 292)
- `'AgentTemplate creation failed'` + `detail: errBody` (line 334)
- `'patch annotation failed'` + `detail: 'see workbench-api logs'` (line 374)

But the W2-Test 6 assertion (line 840):

```typescript
expect((body['error'] as string).toLowerCase()).toMatch(/candidate.template|parse/);
```

This regex matches "candidate-template parse failed" via `parse`, but it ALSO
matches "AgentTemplate creation failed" via `template`. The test does not
distinguish the two error paths and would pass on an incorrect refactor that
swapped them. Worse, `acceptReviewQueueRow` in `api.ts:387-398` only reads
`errBody.error` — the `detail` field (which carries the actual parser error
string from `parseAgentTemplateSpec`) is silently dropped.

**Fix:**

1. Tighten the test assertion: `expect(body['error']).toBe('candidate-template parse failed')`.
2. Surface `detail` in the API helper:

```typescript
// api.ts ReviewActionApiError
export class ReviewActionApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ReviewActionApiError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

// then in acceptReviewQueueRow:
throw new ReviewActionApiError(res.status, errBody.error ?? '...', errBody.detail);
```

The `ReviewPage` and `ReviewActions` `dialogError` displays would then show the
parser's structured failure tag, helping operators correct YAML before retrying.

### WR-03: Classifier's verifier-failed branch does not always populate `reasonDetail` when `verification.reason` is undefined

**File:** `packages/workbench-api/src/routes/review-queue.ts:817`
**Issue:**

```typescript
const reasonDetail = verification.reason ?? 'verifier failed';
```

If `verification.reason === undefined`, the projection emits `'verifier failed'` as
a string, but no `verifierError` is recorded (line 818: `const verifierError = verification.reason;`).
The DTO spec at `dto/review-queue.ts:124` says `verifierError` is "Present only when
`reason === 'verifier-failed'`". The conditional spread at line 829 (`...(verifierError !== undefined && { verifierError })`)
deliberately omits the field — so a verifier-failed row is emitted with NO
`verifierError`, yet `reasonDetail === 'verifier failed'` (a useless tautology).

This violates the DTO's documented invariant: "verifierError ... Present only when
reason === 'verifier-failed'" should be read as "always present when reason ===
'verifier-failed'" (since the row classification is gated on `verification.passed === false`).

**Fix:**
Decision tree:

- If `verification.reason` is genuinely optional in upstream CRD schema (it can be
  set without a reason), emit a structured fallback: `reasonDetail: verification.reason ?? 'verifier_unset_reason'`
  AND `verifierError: verification.reason ?? 'verifier_unset_reason'`. The audit
  warehouse can then group "no reason" failures.
- If verification.reason is implicitly required by spec, add a runtime assertion
  in the classifier and treat undefined as a substrate bug.

```typescript
const verifierReason = verification.reason ?? 'verifier_unset_reason';
const reasonDetail = verifierReason;
const verifierError = verifierReason;
```

### WR-04: Inline `payloadBase64` artifact read has no size cap; OOM on large candidate YAML

**File:** `packages/workbench-api/src/routes/review-queue.ts:266-267`
**Issue:**

```typescript
const b64 = artifactObj['payloadBase64'];
if (typeof b64 === 'string') {
  yaml = Buffer.from(b64, 'base64').toString('utf8');
}
```

No size limit. A 100MB base64 string from the artifact lands in memory then is
decoded again. The accept handler is called via authenticated POST so an attacker
needs operator credentials, but a malicious or buggy agent could emit a giant
candidate artifact and an honest reviewer's accept request becomes an OOM bomb
on the workbench-api.

**Fix:**
Add a max-size guard. AgentTemplateSpec is small by design (per spec): a few
hundred lines of YAML at most. 64KB is generous.

```typescript
const MAX_CANDIDATE_PAYLOAD_BASE64 = 64 * 1024;
if (typeof b64 === 'string') {
  if (b64.length > MAX_CANDIDATE_PAYLOAD_BASE64) {
    return c.json(
      {
        error: 'candidate-template payload too large',
        detail: `max=${MAX_CANDIDATE_PAYLOAD_BASE64} bytes`,
      },
      422,
    );
  }
  yaml = Buffer.from(b64, 'base64').toString('utf8');
}
```

### WR-05: `ReviewActions` annotation access uses optional chaining where eligibility logic relies on truthy-string

**File:** `packages/workbench-ui/src/command/ReviewActions.tsx:61`
**Issue:**

```typescript
const annotations = task.pilotEvidence?.audit?.annotations ?? {};
const eligible =
  task.phase === 'Failed' ||
  (task.suspicious?.length ?? 0) > 0 ||
  annotations[REVIEW_REQUESTED_KEY] === 'true' ||
  annotations[TEMPLATE_CANDIDATE_KEY] === 'true';
```

The check is correct as-is, but the test fixture in `ReviewActions.test.tsx`
exercises only the "true" case. `annotations[KEY]` returns `string | undefined`
because the type is `Readonly<Record<string, string>>`. If a producer accidentally
writes `'True'` or `'TRUE'` (a real bug pattern in YAML CR templates), the
component returns null and the operator has no review surface.

This is the same defensive case the GET classifier handles for `review-requested`
(line 864: `if (annotations[ANNOTATION_REVIEW_REQUESTED] === 'true')`). The
client side and server side use the same exact-case match — so a producer that
writes "True" will be invisible to BOTH. Inconsistency is flagged as a Warning,
not a Critical, because it's symmetric and the spec is consistent.

**Fix:**
Either:

1. Document that case-sensitive `'true'` is the contract and add a server-side
   validator that rejects non-canonical values at admission time (out of scope
   for this phase but worth a TODO).
2. Loosen both client + server to accept `value.toLowerCase() === 'true'`.

Recommend option 1 with a TODO; option 2 invites schema drift.

### WR-06: `requestReview` API helper sends `RequestReviewBody` shape that the server route does not accept

**File:** `packages/workbench-ui/src/api.ts:308-312` and `routes/review-queue.ts:613-620`
**Issue:**
The UI helper declares:

```typescript
export interface RequestReviewBody {
  readonly requestedBy?: string;
  readonly note?: string;
}
```

The server route reads:

```typescript
let body: { reviewerId?: string; reasonText?: string } = {};
// ...
const reviewerId = extractReviewerId(c, body);
const reasonText = typeof body.reasonText === 'string' ? body.reasonText : undefined;
```

`requestedBy` is silently ignored (server reads `reviewerId`); `note` is silently
ignored (server reads `reasonText`). Any future operator-supplied note will fall
through to "unknown" / undefined.

**Fix:**
Align the UI's `RequestReviewBody` to match the server contract:

```typescript
export interface RequestReviewBody {
  readonly reviewerId?: string;
  readonly reasonText?: string;
}
```

Or update the server to accept either field name. Aligning to `reviewerId` /
`reasonText` keeps consistency with `AcceptReviewBody` / `RejectReviewBody`
already declared in `api.ts:297-306`.

### WR-07: `reasonClass()` switch on `replay-divergence` / `eval-failed` is reachable through type but the spec says they're zero-producer

**File:** `packages/workbench-ui/src/ReviewPage.tsx:55-72`
**Issue:**
`reasonClass()` handles all 6 ReviewReason members including the v0.2-zero-producer
`'replay-divergence'` and `'eval-failed'` cases. This is fine defensively, but a
test (`ReviewPage.test.tsx`) does not exercise these branches. If the v0.2 spec
accidentally adds a producer for one of these reasons (e.g., a future Phase 5
patch cherry-picked back to v0.2), the rendered pill style is determined by CSS
classes that are imported but possibly empty — `styles.reasonReplay` / `styles.reasonEval`
ARE defined in `ReviewPage.module.css:120-128`, but the components have no
runtime test verifying rendered DOM for these reasons.

This is also why the `default:` arm at line 70 returns `''` — TypeScript's
exhaustiveness check should make it unreachable for closed-enum `ReviewReason`,
but the empty-string arm masks an exhaustiveness failure if an enum member is
later added.

**Fix:**
Replace the `default:` with an exhaustiveness check:

```typescript
function reasonClass(reason: ReviewReason): string {
  switch (reason) {
    case 'verifier-failed':
      return styles.reasonVerifier ?? '';
    case 'suspicious-detector':
      return styles.reasonSuspicious ?? '';
    case 'human-review-requested':
      return styles.reasonHumanReq ?? '';
    case 'candidate-template':
      return styles.reasonCandidate ?? '';
    case 'replay-divergence':
      return styles.reasonReplay ?? '';
    case 'eval-failed':
      return styles.reasonEval ?? '';
  }
  // Exhaustive by ReviewReason union — TS errors if a new member is added.
  const _exhaustive: never = reason;
  return _exhaustive;
}
```

This way, adding a 7th `ReviewReason` value forces a compile error in the UI.

### WR-08: `useReviewQueue` polling interval has no exponential backoff on persistent error; can hammer the API

**File:** `packages/workbench-ui/src/api.ts:500-512`
**Issue:**

```typescript
useEffect(() => {
  refresh();
  const interval = setInterval(() => {
    refresh();
  }, 5_000);
  return () => {
    clearInterval(interval);
    abortRef.current?.abort();
  };
}, []);
```

If `/api/review-queue` returns 503 (write-disabled, network blip, RBAC misconfig),
the hook re-fires every 5 seconds indefinitely. With a fleet of operator dashboards
open this generates a constant 5-Hz failure-rate against the workbench-api when
a chart is misinstalled. The `setError` path captures the message but doesn't
back off.

This is the same pattern as `fetchDispositions` polling in `state.ts:DISPOSITION_POLL_MS`
(30s) — but the dispositions polling is ALWAYS-on regardless of error state. The
review-queue route is GET-pure-read; a 503 cannot occur (the workbench-api is
the same process serving disposition reads), so the practical risk is low. Still
worth flagging because the polling pattern is broadly copied across the UI
without a backoff helper.

**Fix:**
Either:

1. Add a `retryOnError` flag with exponential backoff to a shared polling helper
   (out-of-scope for this phase).
2. Document the 5s no-backoff policy and add a note that GET endpoints not gated
   by `actions.create=true` cannot meaningfully 503 in this codebase.

## Info

### IN-01: TypeScript `any` leakage at boundary in `routes/review-queue.ts:265`

**File:** `packages/workbench-api/src/routes/review-queue.ts:264-265`
**Issue:**

```typescript
const artifactObj = candidateArtifact.artifactRef as unknown as Record<string, unknown>;
const b64 = artifactObj['payloadBase64'];
```

The double-cast `as unknown as Record<string, unknown>` is correct because
`ArtifactRefSummary` doesn't declare `payloadBase64` (it's a v0.2 implicit
field per the JSDoc). But this is exactly the seam where a future schema
drift bites silently. Future work: declare an extended interface:

```typescript
interface CandidateArtifactRefWithPayload extends ArtifactRefSummary {
  readonly payloadBase64?: string;
}
```

Then the cast becomes a proper type-narrowed access without the double `unknown`.

### IN-02: `Buffer.from(b64, 'base64')` in workbench-api needs Node-runtime guarantee

**File:** `packages/workbench-api/src/routes/review-queue.ts:267`
**Issue:**
`Buffer` is Node-specific. The CLAUDE.md notes the runtime is currently Node 22.
`Buffer` is fine. But if Bun re-enters the picture per the v0.2 plan, `globalThis.Buffer`
behavior may differ slightly for malformed base64. Consider a small wrapper that
fails closed on decode errors rather than producing a garbage UTF-8 string that
the YAML parser then rejects with a confusing error.

```typescript
function decodeBase64Yaml(b64: string): { ok: true; yaml: string } | { ok: false; error: string } {
  try {
    return { ok: true, yaml: Buffer.from(b64, 'base64').toString('utf8') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

`Buffer.from(...).toString('utf8')` is unlikely to throw, so this is
nice-to-have rather than load-bearing.

### IN-03: Test fixture `review-queue-snapshot.json` has stalenessSeconds expectation tied to `fixedNow = 2026-05-10T12:00:00Z`

**File:** `packages/workbench-api/src/routes/review-queue.test.ts:65`
**Issue:**
The fixed clock is set in the test to deterministic 2026-05-10T12:00:00Z, and
fixture timestamps are intentionally older to produce non-zero stalenessSeconds.
This works — but a Reader looking at the fixture file alone won't see the linkage.
Consider a comment in the fixture file's first task pointing to the test's
fixed clock.

### IN-04: License headers + module JSDoc style

All new files in scope carry the MIT SPDX header and a module-level JSDoc
explaining purpose. Project mandate per CLAUDE.md is met. No action needed.

### IN-05: Tests do not exercise `extractReviewerId()` priority order

**File:** `packages/workbench-api/src/routes/review-queue.ts:701-718`
**Issue:**
`extractReviewerId()` resolves the reviewer ID via three sources in order: body
field, header, then auth-middleware var. Tests cover the body-omitted +
header-present path (`W2-Test 1`) and the no-header fallback (`W2-Test 11`),
but not:

- Body field present overrides header (the documented priority 1 → 2)
- Header empty-string is treated as absent
- `c.var.user` fallback (priority 3)

These would round out the priority test matrix. Low-risk because the function
is small and the tested paths are the most-used; promote to Warning if a
future refactor merges the three paths.

---

_Reviewed: 2026-05-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
