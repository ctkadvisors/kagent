# REV3 Fix — Gateway (C3-REV3-H1)

**Agent:** rev3-fix-gateway
**Task:** Close C3-REV3-H1 (HIGH) — B5 partial fix's router-path bypass.
**HEAD before:** `10c2a0c`
**Date:** 2026-05-07
**Severity closed:** 1 HIGH

---

## Finding

`packages/llm-gateway/src/model-index.ts:147` returned `minSafe: ep.spec.minSafe ?? 1` (unclamped). For a CR with `spec.minSafe: 0`, the nullish-coalescing operator does not substitute (`0` is not nullish), so the lookup returned `0`. `router.ts:148-153` calls `aimd.updateBounds` with that value on every request, overwriting watch-time normalization (`Math.max(1, …)` at `model-watch.ts:179`). After the first request, `aimd.state.bounds.minSafe = 0`, and `onError` halves `state.cap` toward 0 (`Math.max(0, floor(cap/2))`), pinning capacity at zero — original B5 DoS restored.

`admin-routes.ts:183` had the same bug, display-only — operators saw `minSafe: 0` in `/admin/capacity` rows when AIMD enforced 1.

## Sibling check

Grep `spec.minSafe` across `packages/llm-gateway/src/` (production, non-test) returned exactly the 3 audit-cited read sites:

1. `model-watch.ts:179` (already clamped via `Math.max(1, …)`)
2. `model-index.ts:147` (unclamped — fixed)
3. `admin-routes.ts:183` (unclamped — fixed)

No fourth bypass site exists. The other matches are: type definition (`types.ts:248`), test fixtures (`router.test.ts:95`, `model-watch.test.ts:79`, `model-index.test.ts:52`), and now the centralized clamp in the new `bounds.ts`. Confirmed via `grep -rn 'spec.minSafe' packages/llm-gateway/src/` post-fix — only the new `bounds.ts:66` performs the actual `ep.spec.minSafe` read; both `model-index.ts` and `admin-routes.ts` references are JSDoc/comment-only.

## Fix shape — DRY-up via dedicated module

Picked the cleaner approach the audit suggested: extract `normalizeBounds` into a dedicated `packages/llm-gateway/src/bounds.ts` module and have all 3 read sites import from it.

Why a new module rather than re-exporting from `model-watch.ts`:
- `model-watch.ts` imports `@kubernetes/client-node` at the top level (heavy K8s deps, informer machinery).
- `model-index.ts` is a pure data structure used by router unit tests that do not boot the K8s client.
- Importing from `model-watch.ts` would pull in the K8s client into every router test transitively, slowing test boot and risking circular-import issues.
- The dedicated 65-line module decouples the clamp from the K8s informer entirely.

`model-watch.ts` re-exports `normalizeBounds` for back-compat with existing importers (none in production today, but the test file imports it from `./model-watch.js`).

Centralized constant `MIN_SAFE_FLOOR = 1` documents the load-bearing AIMD invariant.

## Files changed (all under `packages/llm-gateway/src/`)

| File | Change |
|---|---|
| `bounds.ts` (NEW) | Canonical `normalizeBounds` + `MIN_SAFE_FLOOR` constant. |
| `model-watch.ts` | Removed local `normalizeBounds` definition; re-exported from `./bounds.js` for back-compat. |
| `model-index.ts` | `lookup()` now funnels through `normalizeBounds` — closes C3-REV3-H1 attack vector. |
| `admin-routes.ts` | `buildCapacityResponse` rows now funnel through `normalizeBounds` — display matches AIMD-enforced reality. |
| `model-index.test.ts` | +2 regression tests: clamp `spec.minSafe=0` and negative on lookup. |
| `admin-routes.test.ts` | +1 regression test: clamp `spec.minSafe=0` in `/admin/capacity` rows. |
| `router.test.ts` | +1 end-to-end attack reproduction: malicious CR → request through router → AIMD `bounds.minSafe` ends at 1, `currentCap` floors at 1 after 10 errors. |

## Regression verification

The router-path test (`router.test.ts: lookup-time clamp prevents the router-path B5 bypass (C3-REV3-H1)`) reproduces the full attack:

1. CR with `spec.minSafe: 0`.
2. `ModelIndex.lookup()` returns `minSafe: 1` (asserted).
3. Request flows through `route()` — `aimd.updateBounds` is fed the clamped value.
4. 10 forced `onError` calls — `currentCap` floors at 1 (asserted).
5. `aimd.snapshot().minSafe` is 1 (asserted).

Pre-fix simulation (mental): without the lookup-time clamp, step 2 would return 0, step 3 would set `bounds.minSafe = 0`, step 4 would collapse cap to 0, and the snapshot would expose `minSafe: 0`. Test fails on assertion 2.

## Verification

```
cd packages/llm-gateway && npm run typecheck   # OK
cd packages/llm-gateway && npm run lint        # OK (0 warnings)
cd packages/llm-gateway && npm test            # 250 passed (20 files)
cd packages/workbench-api && npm run typecheck # OK
cd packages/workbench-api && npm test          # 152 passed (12 files)
```

## Commit

`fix(llm-gateway): clamp minSafe at all spec read sites to close B5 router bypass (C3-REV3-H1)`

Direct push to main per user's auto-memory.
