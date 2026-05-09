# W0-Gateway — BLOCKER fix report

**Agent:** W0-Gateway
**Scope:** B5, B6, B7 (workbench/gateway/security boundary)
**HEAD before:** `fc32b13`
**HEAD after:** `6000ac6`
**Pushed to `origin/main`:** yes

---

## 1. Commits

All three commits are atomic, pushed, and signed off with the
`Co-Authored-By: Claude Opus 4.7 (1M context)` trailer per the project's
ctkadvisors style.

| BLOCKER | Commit | Files | Tests |
|---|---|---|---|
| **B5** | `67124d9` `fix(workbench-api, llm-gateway): clamp minSafe to 1 to prevent permanent cap collapse (B5)` | 4 files, +92/-8 | +5 regression tests |
| **B6** | `eeb6b5d` `fix(operator/chart): fail Helm install when workbench auth is unset on default-fail-open path (B6)` | 3 files, +65 | helm-render verification (5 paths) |
| **B7** | `6000ac6` `fix(llm-gateway/chart, llm-gateway): split bundled-Postgres credentials and require sslmode=verify-* (B7)` | 11 files, +521/-81 | +7 regression tests |

---

## 2. B5 — `MIN_SAFE_MIN=0` permits PATCH DoS

### Changes

* `packages/workbench-api/src/routes/gateway.ts:90` — raised
  `MIN_SAFE_MIN` from `0` to `1`. PATCH validator now rejects
  `minSafe: 0` with a `400` error.
* `packages/llm-gateway/src/model-watch.ts:80` — extracted a
  `normalizeBounds` helper that applies
  `Math.max(1, ep.spec.minSafe ?? 1)`. This closes the bypass where a
  CR with `spec.minSafe: 0` would pass through `??` (nullish
  coalescing only filters `null`/`undefined`, not `0`) and pin the
  AIMD floor to `0`.
* `packages/llm-gateway/src/aimd.ts:139,157` — verified, no change
  needed. The existing `Math.max(state.bounds.minSafe, Math.floor(state.cap / 2))`
  clamp now respects `>= 1` because the watch-time normalization
  guarantees `bounds.minSafe >= 1`.

### Regression tests added

* `gateway.test.ts`: `rejects minSafe=0 (B5 regression)`,
  `accepts minSafe=1 as the lowest legal value`.
* `model-watch.test.ts`: 4 new cases on `normalizeBounds` covering
  the pass-through, default, `minSafe=0` clamp, and negative-value
  clamp paths.

### Verification

* `cd packages/llm-gateway && npm run typecheck && npm run lint && npm test` — 165/165 pass.
* `cd packages/workbench-api && npm run typecheck && npm run lint && npm test` — 114/114 pass.

---

## 3. B6 — default fail-open auth on flannel K3s

### Design

The chart's old default rendered a vanilla Ingress with an empty
`authMiddleware` AND `api.authRequired='true'`. The cluster-side
defense against `X-Forwarded-User` spoofing is the chart's
NetworkPolicy, but K3s ships flannel which silently ignores it. The
fail-open posture was the default install.

The fix converts that posture into a loud Helm-time failure:

* `templates/_helpers.tpl` — adds `kagent-workbench.validateValues`
  helper that calls `fail` when:
  * `ingress.enabled=true`, AND
  * `ingress.authMiddleware` is empty, AND
  * `api.authRequired=='true'`, AND
  * `acknowledgeUnauthenticated != true`.
* `templates/deployment.yaml` — includes the validation helper at the
  top so every render exercises the guard.
* `values.yaml` — introduces `acknowledgeUnauthenticated: false` with
  the trapdoor explanation. References AGENT-SELF-SERVICE.md §3.5
  and evidence/audit-rev2/C3.md.

### Verification (helm template)

| Scenario | Expected | Result |
|---|---|---|
| default (`ingress.enabled=false`) | render | OK |
| `ingress.enabled=true, authMiddleware=''` (default `authRequired='true'`) | FAIL | FAIL with audit-B6 message |
| `ingress.enabled=true, authMiddleware='kagent-workbench-basic-auth'` | render IngressRoute | OK |
| `ingress.enabled=true, authMiddleware='', acknowledgeUnauthenticated=true` | render Ingress | OK |
| `ingress.enabled=true, authMiddleware='', api.authRequired='false'` | render Ingress (operator opted out of auth) | OK |
| `ci/kind-smoke-values.yaml` overlay | render | OK (smoke uses `ingress.enabled=false`) |

---

## 4. B7 — cleartext bundled-Postgres DSN

### Design

The chart's `secret-bundled.yaml` rendered a single Secret with
`stringData.dsn = "postgres://USER:PASSWORD@HOST:5432/DB?sslmode=disable"`.
Two concerns:

1. The cleartext password was readable by anyone with `secrets:get`
   on the namespace, right next to all the other connection metadata.
2. `sslmode=disable` meant the password also crossed the wire in
   cleartext.

Fix:

* **Chart**:
  * `templates/secret-bundled.yaml` — emits user/password/host/port/
    database as **separate `stringData` keys**. The DSN string with
    the embedded password is gone.
  * `templates/deployment.yaml` + `templates/migration-job.yaml` —
    consume each split key via individual `secretKeyRef` env vars
    (`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE`)
    in BUNDLED mode. BYO mode keeps the legacy `DATABASE_URL` env via
    `database.dsnSecretRef` (back-compat).
  * `templates/_helpers.tpl` — adds `bundledSecretName` and
    `bundledSslMode`. The latter rejects `sslmode=disable` at template
    time.
  * `values.yaml` — introduces `database.bundledConfig.sslMode`
    (default `verify-ca` because Bitnami's auto-generated cert SAN
    may not match the Service hostname; deployers can move to
    `verify-full` after reissuing with the correct SAN).
  * `templates/NOTES.txt` — documents the new Secret shape and TLS mode.
  * `README.md` — adds "Bundled-Postgres TLS" section, calls out
    Sealed-Secrets / external-secrets as the production path,
    upgrades BYO-mode example DSN to `sslmode=verify-full`.

* **Code**:
  * `src/env.ts` — adds `parseDatabaseConn`, introduces
    `DatabaseConnConfig`, changes `parseEnv` to populate either
    `databaseUrl` (DSN back-compat) OR `database` (split). Split
    wins when both are set.
  * `src/db/pool.ts` — extends `createPool` to accept either
    `connectionString` or `connConfig`. Split path constructs the
    `pg.Pool` config with individual props plus `pg.PoolConfig['ssl']`
    projected from the libpq verb. Optional CA bundle from
    `PGSSLROOTCERT`.
  * `src/main.ts` — selects the right factory signature and logs
    the DB mode at boot.

### Regression tests added (`src/env.test.ts`)

* `parseEnv prefers split-env (PG*) over DATABASE_URL when both are set`.
* `parseEnv parses split-env without DATABASE_URL`.
* `parseDatabaseConn returns null when no PG* vars are set`.
* `parseDatabaseConn returns the full config when all four required vars are set`.
* `parseDatabaseConn throws when split-env is partial (PGHOST without PGPASSWORD)`.
* `parseDatabaseConn passes through whitespace-bearing PGPASSWORD without trimming`.
* `parseDatabaseConn rejects an unknown PGSSLMODE value`.

### Verification (helm template)

| Scenario | Expected | Result |
|---|---|---|
| `ci/values-bundled-postgres.yaml` | render | OK; Secret has split keys, Deployment+Job consume PG* envs, PGSSLMODE=`verify-ca` |
| `ci/values-byo-postgres.yaml` | render | OK; no auto-Secret, Deployment+Job consume `DATABASE_URL` from `database.dsnSecretRef` |
| `database.bundledConfig.sslMode=disable` | FAIL | FAIL with audit-B7 message |

### Verification (code)

* `cd packages/llm-gateway && npm run typecheck && npm run lint && npm test` — 165/165 pass (was 158, +7 new B7 cases).
* `cd packages/workbench-api && npm run typecheck && npm run lint && npm test` — 114/114 pass (unchanged).
* `cd packages/workbench-ui && npm run typecheck && npm run lint && npm test && npm run build` — clean, 228 KB bundle.

---

## 5. Wired-but-dead-code scan

Scoped to my packages (`llm-gateway/src`, `workbench-api/src`,
`workbench-ui/src`).

### Step 1 — grep results

```bash
grep -rnE 'deps\.\w+\?\.\(' packages/llm-gateway/src packages/workbench-api/src packages/workbench-ui/src --include='*.ts' --exclude='*.test.ts'
# (no matches)

grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/llm-gateway/src packages/workbench-api/src packages/workbench-ui/src --include='*.ts' --exclude='*.test.ts'
# (no matches)

grep -rnE '\w+\.\w+\?\.\(' packages/llm-gateway/src packages/workbench-api/src packages/workbench-ui/src --include='*.ts' --exclude='*.test.ts'
# (no matches)

grep -rnE '\b(audit|metric|emit|track|log|notify|hook|sink|recorder|trace)\?\.\(' packages/llm-gateway/src packages/workbench-api/src packages/workbench-ui/src --include='*.ts' --exclude='*.test.ts'
# (no matches)
```

The wired-but-dead-code grep predicates from the paradigm doc match
**zero** sites in my package scope today. There is no
`deps.<name>?.()` pattern, no `?.() ?? {}` pattern, no
`audit?.()` / `metric?.()` style optional-call site in production
code paths in any of the three packages.

### Step 2 — H18 confirmation (audit-rev2 finding)

The audit's H18 finding (`apiKeyRepo.touchLastUsed` is never called
from production) is structurally similar but is NOT a
wired-but-dead-code instance per the paradigm — it's an
**unconnected production capability**, not a wired-but-dead optional
call.

| Question | Answer |
|---|---|
| Is the dep declared in a `deps`-style options object with `?`? | No — `apiKeyRepo: ApiKeyRepo` is a required dep at `server.ts:61` |
| Is the production wire-up site passing the dep? | Yes — `main.ts:64,100` constructs and threads `apiKeyRepo` into `server.ts` |
| Does the test inject the dep? | Yes — `server.test.ts:44` injects a mock `touchLastUsed` |
| What does the production codepath do with `touchLastUsed`? | `server.ts` consumes `apiKeyRepo` for `handleCreateApiKey` (line 162), `handleListApiKeys` (line 187), `handleRevokeApiKey` (line 213) — but **never invokes `touchLastUsed`** at the auth-resolve point. The method is dead production code, not via an optional-call fallback but via straightforward unwiring at the auth callsite. |

This is a regular "missing call" bug, not a wired-but-dead-code site
in the paradigm sense (no optional `?.()` operator, no `??` fallback
to a sensible-looking default). The audit-rev2 fix (queue as a
follow-up) still stands; H18 falls outside the paradigm even though
it shares the spirit ("test-passes / production-dead").

### Step 3 — confirmed wired-but-dead sites

**None.**

The substrate's gateway/workbench surfaces don't currently use the
optional-dep + fallback shape that produces this anti-pattern.

---

## 6. Downstream-impact notes for `../new_localai` (do NOT modify)

Per the user's auto-memory ("Do GitOps-doable cluster follow-ups,
don't bounce them back"), these are the changes the user will likely
need to apply to `../new_localai/` after my B6/B7 changes land:

### B6 — `kagent-workbench` chart consumer

The `new_localai/k8s/argocd-apps/kagent-workbench-app.yaml` Argo
Application's values overlay must now satisfy the B6 guard. **Two
choices** (recommended → secure):

1. **Set `ingress.authMiddleware` to a Traefik Middleware that
   authenticates the request.** The homelab already has a
   `kagent-workbench-basic-auth` Middleware mentioned in the chart
   docstring. If that Middleware exists in `kagent-system` (or
   wherever the workbench is deployed), set:

   ```yaml
   ingress:
     enabled: true
     authMiddleware: 'kagent-workbench-basic-auth'
     host: kagent.knuteson.io
     tls:
       secretName: knuteson-tls
   ```

2. **Acknowledge the trapdoor** if (and only if) the cluster has a
   NetworkPolicy-enforcing CNI deployed (Calico/Cilium/Weave). The
   homelab is K3s with default flannel, so this is NOT a recommended
   path here:

   ```yaml
   acknowledgeUnauthenticated: true
   ```

If neither is set, `argocd-apps/kagent-workbench-app.yaml` will sync
to a Helm-render error and the workbench Application will go
**Failed** in Argo. The `helm template` failure message names the
docs/AGENT-SELF-SERVICE.md §3.5 path explicitly so the user can
diagnose without reading code.

### B7 — `kagent-llm-gateway` chart consumer (if deployed)

Two consumer scenarios:

1. **`database.bundled=true` (homelab-typical):**
   * **No values.yaml change required** for the password split — the
     chart auto-creates the `<release>-llm-gateway-db` Secret with
     the new split keys on first sync. The Bitnami sub-chart honors
     `auth.existingSecret` so no password drift.
   * **The default `sslMode: verify-ca`** kicks in. If the Bitnami
     auto-generated cert's SAN doesn't match the Service hostname,
     the gateway Pod will fail readiness with a TLS-handshake error.
     Two remediations:
     * Override `database.bundledConfig.sslMode: require` (TLS
       without CA verification — second-best, documented in the
       chart README).
     * Reissue the Bitnami cert with the correct SAN and keep
       `verify-ca` (or move to `verify-full`).
   * The chart README now documents both.
   * Existing installs: on `helm upgrade`, the auto-Secret will be
     **replaced** with the split-key shape. **The Bitnami sub-chart
     keeps its data PVC**, so the password persists across the
     upgrade (the chart looks up the existing password and keeps it).
     Migration is hands-off; the migration Job re-runs (idempotent)
     against the same DB.

2. **`database.bundled=false, dsnSecretRef=*` (cloud-typical):**
   * **No change required.** The BYO path is unchanged. Existing
     `dsnSecretRef`-backed Secrets continue to work via the
     `DATABASE_URL` env path.
   * The chart README now nudges deployers to use
     `sslmode=verify-full` in the DSN; existing DSNs with
     `sslmode=require` keep working but should be tightened.

### Notes on what to verify after the user merges

* Argo `kagent-workbench` Application: verify `Sync Status: Synced,
  Healthy: Healthy` after the values overlay update.
* Argo `kagent-llm-gateway` Application (if deployed): verify the
  gateway Pod's `/readyz` returns 200 (the `pingPool` SELECT 1 will
  fail loudly if the new TLS handshake doesn't work).
* Optional: a one-off `Job` that probes the workbench's
  `/api/cluster/snapshot` from a non-ingress-controller Pod to
  confirm the auth gate now blocks (B6 cluster-side enforcement;
  only meaningful with an enforcing CNI).

---

## 7. Out of scope (per orders)

* B3 / B4 — Operator team
* NB1 — Pod team
* All H/M Gateway findings (W2/W3-Gateway)
* `../new_localai/` modifications (user's GitOps follow-up)
* `../agent-runtime/`, `../homelab-orchestrator/` (sibling repos)

---

## 8. Blockers encountered

* **`pre-commit` hook + lint-staged interaction** — running the
  pre-commit hook with **all** working-tree files modified by parallel
  agents caused `lint-staged` to silently re-stage the wrong files
  on the first attempt. Resolved by stashing all out-of-scope files
  before each commit, popping the stash after, and never crossing
  team-boundary commits.
* **`pnpm` engine guard** — the pre-commit hook runs `pnpm` which
  rejects Node 23.11 (default on this machine) per the root
  `engines.node: '>=22.0.0 <23.0.0'`. Worked around by setting
  `PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` for each
  commit invocation. **Not** a code change to bypass the guard;
  the guard is correct.

---

## 9. Final state

```
$ git log --oneline -5 origin/main
6000ac6 fix(llm-gateway/chart, llm-gateway): split bundled-Postgres credentials and require sslmode=verify-* (B7)
78975df fix(agent-pod): wire tokenUtilizationSnapshot to live RunBudget for get_my_context (NB1)
3d71a7b fix(operator): skip verifier-labeled Jobs in onJob handler to avoid clobbering parent AgentTask conditions (B3)
eeb6b5d fix(operator/chart): fail Helm install when workbench auth is unset on default-fail-open path (B6)
67124d9 fix(workbench-api, llm-gateway): clamp minSafe to 1 to prevent permanent cap collapse (B5)
```

All three BLOCKERs in scope (B5, B6, B7) are fixed and pushed.
