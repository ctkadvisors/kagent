# Enterprise Pilot RC — Scenario Bundle Runbook

This directory ships the manifests an operator runs to capture the
Enterprise Pilot RC evidence pack defined in
[`docs/GA-HARDENING.md`](../../docs/GA-HARDENING.md) and
[`docs/GA-EVIDENCE-CHECKLIST.md`](../../docs/GA-EVIDENCE-CHECKLIST.md).

The bundle is Kustomize-friendly. One scenario per file under
`examples/rc-pilot/`; one row per scenario in the checklist.

```
examples/rc-pilot/
  kustomization.yaml
  README.md                  # this runbook
  00-namespace.yaml          # kagent-rc-pilot namespace
  01-agents.yaml             # reusable Agent CRs
  10-happy-path.yaml         # AgentTask → Completed, clean detector
  20-forced-timeout.yaml     # AgentTask → Failed/timeout
  30-image-pull-fail.yaml    # Agent + AgentTask → ImagePullBackOff
  40-delegation.yaml         # parent AgentTask spawning 2-3 children
  50-artifact-producer.yaml  # AgentTask → status.artifacts populated
  60-verifier.yaml           # AgentTask with verifyContract (pass + fail)
  70-policy-cap.yaml         # Agent + AgentTask exposing policy caps
  80-audit-stamps.yaml       # AgentTask exercising tenant + audit stamps
```

The reviewer-facing artifact is the directory the evidence collector
writes (`evidence/rc-<n>/` by default). Workbench reads cached CRD
state, so the same evidence pack reproduces from a stored cluster
snapshot — the operator does not need shell access to controllers to
audit the run.

## 1. Prereqs check

Confirm the operator chart values BEFORE applying the bundle. The RC
hardening §"Capability Runtime Gate" demands the gates below; the
bundle still applies cleanly without them, but specific evidence rows
will be empty.

| Feature gate | Required for | Helm values key | Default | RC posture |
| --- | --- | --- | --- | --- |
| Capability mint | `pilotEvidence.capabilityRef`; `keyrotation.cap_minted_with_ttl` audit; cap-gated spawn | `capabilities.enabled` | `false` | `true` (with `capabilities.signingSecretName` set) |
| Capability key rotation | TTL-bound caps for short / long tasks | `keyRotation.enabled` | `false` | `true` |
| Audit stream | `capability.minted` / `capability.used` events | `audit.enabled` | `true` | `true` |
| Tenancy | per-tenant issuer; `claims.tenant` on minted caps | `tenancy.enabled` | `false` | `true` (when Tenant CRs exist) |
| Artifact PVC | `status.artifacts` populated for scenario 50 | `agentPod.artifacts.enabled` | varies by build | `true` |
| Egress | per-Agent NetworkPolicy correlation | `egress.enabled` | `false` | optional |
| LLM gateway admission | `policy_denied:tenant_gateway_inflight_exceeded` if exercised | `llmGateway.enabled` | `false` | optional |

Inspect the running operator's effective values:

```bash
helm -n kagent-system get values kagent-operator
```

When a scenario depends on a gate that is OFF, you have three
options:

1. Flip the gate, redeploy, and re-run only that scenario.
2. Capture the row anyway and mark it explicitly reviewed in
   `summary.md` (acceptable per `docs/GA-HARDENING.md` §"Acceptance
   Gates" when the gap is deliberate).
3. Skip the row and flag it on the reviewer sign-off.

The bundle's `commonLabels` include `kagent.knuteson.io/tenant: enterprise-pilot`
so `pilotEvidence.audit.tenant` reads the same value on every task —
even when `tenancy.enabled=false`. The cap-mint row simply reads
"missing" in that case.

### Cluster prerequisites

- `kubectl` v1.27+ on the workstation; `kubectl apply -k` is sufficient
  (no standalone `kustomize` binary required).
- The `kagent-operator` chart already deployed and the operator pod
  Running.
- The `kagent-workbench-api` chart deployed; the API responds on a
  reachable URL (default `http://kagent-workbench.kagent-system.svc.cluster.local:8080`).
- `node` 22+ on the workstation (the evidence collector is a single ESM
  script and uses the platform `fetch`).
- For scenario 50 (artifact producer): the substrate's PVC-backed
  artifact writer wired into the agent-pod (`agentPod.artifacts.enabled`).
- For scenario 60 (verifier): a Langfuse prompt named
  `rc-pilot-verifier-jsonshape` v1 OR a kustomize patch swapping the
  `verifyContract.llmJudgePromptRef.name` to a prompt that already
  exists in your install. See §"Open questions" below.

## 2. Apply order

The bundle is applied as a single Kustomize root. All resources land
in `kagent-rc-pilot`.

```bash
# from the repo root
kubectl apply -k examples/rc-pilot/

# expect roughly:
#   namespace/kagent-rc-pilot created
#   agent.kagent.knuteson.io/rc-pilot-orchestrator created
#   agent.kagent.knuteson.io/rc-pilot-summarizer created
#   agent.kagent.knuteson.io/rc-pilot-artifact-writer created
#   agent.kagent.knuteson.io/rc-pilot-verifier-gated created
#   agent.kagent.knuteson.io/rc-pilot-policy-capped created
#   agent.kagent.knuteson.io/rc-pilot-bad-image created
#   agenttask.kagent.knuteson.io/rc-pilot-happy-path created
#   agenttask.kagent.knuteson.io/rc-pilot-forced-timeout created
#   agenttask.kagent.knuteson.io/rc-pilot-image-pull-fail created
#   agenttask.kagent.knuteson.io/rc-pilot-delegation created
#   agenttask.kagent.knuteson.io/rc-pilot-artifact-producer created
#   agenttask.kagent.knuteson.io/rc-pilot-verifier-pass created
#   agenttask.kagent.knuteson.io/rc-pilot-verifier-fail created
#   agenttask.kagent.knuteson.io/rc-pilot-policy-cap created
#   agenttask.kagent.knuteson.io/rc-pilot-audit-stamps created
```

Watch tasks reach a terminal phase (Completed / Failed):

```bash
kubectl get agenttask -n kagent-rc-pilot -w
```

Most scenarios reach terminal in under 2 minutes. The forced-timeout
scenario should fail within ~5 seconds. The image-pull-fail scenario
hangs in `Pending`/`Dispatched` — you may force-timeout it from
the workbench UI or simply capture mid-flight; the
`containerStatuses` projection still carries the
`ImagePullBackOff`/`ErrImagePull` reason.

If any task is still in `Pending` after 10 minutes that you did NOT
expect to be slow, dump the operator logs for that AgentTask UID
before concluding — it is usually admission-time policy denial:

```bash
kubectl get agenttask -n kagent-rc-pilot -o wide
kubectl get agenttask -n kagent-rc-pilot rc-pilot-happy-path -o yaml
kubectl logs -n kagent-system deploy/kagent-operator | grep <task-uid>
```

## 3. Forcing the image-pull failure

The v0.1 Agent CRD does not expose `spec.image` (the operator's
job-spec builder sources the agent-pod image from chart Helm values).
To make scenario 30 reach `ImagePullBackOff` cleanly, follow ONE of
these options at evidence-capture time:

**Option A — values overlay on a scratch operator (recommended):**

```yaml
# values-rc-pilot-bad-image.yaml
agentPod:
  image:
    repository: ghcr.io/ctkadvisors/kagent-agent-pod-DOES-NOT-EXIST
    tag: rc-pilot-bad-image
    pullPolicy: Always
watchNamespace: kagent-rc-pilot
```

Install in a scratch namespace (`kagent-rc-pilot-bad-image`) for the
duration of the capture, then teardown.

**Option B — temporary deployment env edit:**

```bash
kubectl -n kagent-system set env deploy/kagent-operator \
  KAGENT_AGENT_POD_IMAGE_REPOSITORY=ghcr.io/ctkadvisors/kagent-agent-pod-DOES-NOT-EXIST \
  KAGENT_AGENT_POD_IMAGE_TAG=rc-pilot-bad-image
# capture evidence, then revert:
kubectl -n kagent-system set env deploy/kagent-operator \
  KAGENT_AGENT_POD_IMAGE_REPOSITORY- KAGENT_AGENT_POD_IMAGE_TAG-
```

**Option C — skip the row.** Mark it explicitly reviewed in
`summary.md` if your install does not allow either of the above. The
checklist permits a deliberate gap when noted.

## 4. Capture evidence

The evidence collector is `scripts/collect-workbench-evidence.mjs`.
Run from the repo root, pointed at the Workbench API:

```bash
# port-forward the Workbench API to your workstation if needed:
kubectl -n kagent-system port-forward svc/kagent-workbench 18999:8080 >/dev/null 2>&1 &
PF_PID=$!

# capture the pack. The collector reads /healthz, /readyz, /api/tasks,
# and /api/tasks/<ns>/<name> for every selector.
node scripts/collect-workbench-evidence.mjs \
  --base-url http://127.0.0.1:18999 \
  --namespace kagent-rc-pilot \
  --out evidence/rc1

# stop port-forward
kill "$PF_PID" 2>/dev/null
```

When the Workbench API requires SSO, override the auth header:

```bash
node scripts/collect-workbench-evidence.mjs \
  --base-url https://workbench.knuteson.io \
  --namespace kagent-rc-pilot \
  --user pilot-reviewer \
  --header "Authorization=Bearer ${WORKBENCH_TOKEN}" \
  --out evidence/rc1
```

The collector writes:

```
evidence/rc1/
  manifest.json              # capture time, source URL, file list
  healthz.json               # API liveness snapshot
  readyz.json                # API readiness snapshot
  tasks.json                 # task list response
  task-details/              # one JSON per pilot task, by ns__name
    kagent-rc-pilot__rc-pilot-happy-path.json
    ...
  summary.md                 # reviewer matrix
```

Verify the pack against the checklist (`docs/GA-EVIDENCE-CHECKLIST.md`):

```bash
ls evidence/rc1/task-details/   # one file per applied AgentTask
jq .pilotEvidence.audit.tenant evidence/rc1/task-details/kagent-rc-pilot__rc-pilot-audit-stamps.json
jq .pilotEvidence.policy evidence/rc1/task-details/kagent-rc-pilot__rc-pilot-policy-cap.json
```

## 5. Mapping table

Each scenario file maps to exactly one row in
`docs/GA-EVIDENCE-CHECKLIST.md` §"Required Scenario Rows". Verifier
ships two rows (pass / fail case).

| Scenario file | Manifests | Checklist row | Required pilotEvidence fields |
| --- | --- | --- | --- |
| `10-happy-path.yaml` | `AgentTask/rc-pilot-happy-path` | Happy path | `phase=Completed`, `structuralVerdict.suspicious=[]`, `runConfig.timeoutSeconds`, non-empty `result` |
| `20-forced-timeout.yaml` | `AgentTask/rc-pilot-forced-timeout` | Model timeout | `phase=Failed`, terminal `error` mentions timeout/deadline, `runConfig.timeoutSeconds=1` |
| `30-image-pull-fail.yaml` | `AgentTask/rc-pilot-image-pull-fail` | Image pull or pod failure | `containerStatuses[*].state.waiting.reason ∈ {ImagePullBackOff, ErrImagePull}` |
| `40-delegation.yaml` | `AgentTask/rc-pilot-delegation` | Parent/child delegation | `taskGraph.childCount > 0`, counters sum, `aggregatePhase` populated |
| `50-artifact-producer.yaml` | `AgentTask/rc-pilot-artifact-producer` | Artifact producer | `artifacts.count > 0`, status.artifacts[0].uri starts with `pvc://kagent-artifacts/` |
| `60-verifier.yaml` (pass) | `AgentTask/rc-pilot-verifier-pass` | Contract verifier (pass) | `verification.passed=true`, `verification.mode=llmJudge` |
| `60-verifier.yaml` (fail) | `AgentTask/rc-pilot-verifier-fail` | Contract verifier (fail review) | `verification.passed=false`, terminal `phase=Failed`, `error` carries `verify_failed` |
| `70-policy-cap.yaml` | `AgentTask/rc-pilot-policy-cap` | Policy cap | `policy.maxConcurrentChildren=2`, `policy.maxInFlightTasks=4`, `policy.allowedChildAgents`, `policy.allowedChildTemplates` |
| `80-audit-stamps.yaml` | `AgentTask/rc-pilot-audit-stamps` | Audit stamps | `audit.tenant=enterprise-pilot`, `audit.createdBy=rc-pilot-runbook`, `audit.managedBy=kagent-rc-pilot`, `capabilityRef` populated when `capabilities.enabled` |

## 6. Cleanup

```bash
kubectl delete -k examples/rc-pilot/
```

Cascade-delete on the `Namespace` removes all CRs in one shot. The
operator's reconciler observes the delete and removes the spawned
Jobs / Pods on its next pass; force-deleting the namespace is rarely
needed but available via `kubectl delete ns kagent-rc-pilot --wait=false`.

Stored evidence packs (`evidence/rc-*/`) are intentionally left on
disk — they are the artifact you hand the reviewer.

## 7. Open questions

These are scenario-level gaps that the v0.1 CRDs do not let us
encode cleanly. Each is parked here rather than written as invalid
YAML so a future revision of the bundle can pick them up.

### 7.1 Forcing image pull failure without a values overlay

There is no `Agent.spec.image` field in the v1alpha1 CRD; the operator
sources the agent-pod image from chart Helm values
(`agentPod.image.repository:tag`). Until v0.2 carves a per-Agent image
override, the canonical way to reach `ImagePullBackOff` is via the
operator's values overlay or env edit (see §3 above). A future CRD
bump that adds `Agent.spec.image` would let scenario 30 carry the
bad image inline.

### 7.2 Verifier prompt provisioning

The verifier scenarios reference a Langfuse prompt named
`rc-pilot-verifier-jsonshape` at `version: 1`. If your install does
not yet have that prompt, either:

- create it in Langfuse with body roughly:

  ```text
  You are a strict JSON shape validator. The agent emitted:
  ---
  {{outputs}}
  ---
  Reply with strict JSON of shape {"verdict": "pass"|"fail", "reason": "<why>"}.
  Pass ONLY when the agent's output is valid JSON of shape
  {"answer": "<single sentence>"}.
  ```

- or apply a kustomize JSON-patch overlay swapping the ref to a prompt
  that already exists. Both verifier tasks share the same ref, so a
  single patch covers both.

When neither asset is available the verifier still produces evidence
(`pilotEvidence.verification.passed=false` with
`reason=verify_failed`) — the gate is observable; only the
distinction between the pass case and fail case collapses.

### 7.3 Artifact writer wiring

The `write_artifact` built-in tool (see
`packages/agent-pod/src/builtin-tools.ts`) is wired in v0.1 BUT
requires `agentPod.artifacts.enabled=true` on the chart so the
artifact PVC is mounted into spawned Jobs. When this gate is OFF,
scenario 50 still completes but `status.artifacts` stays empty. The
checklist's "Artifact producer" row tolerates a deliberate gap when
explicitly noted in `summary.md`; flipping the gate is the canonical
fix.

### 7.4 Capability mint visibility

`pilotEvidence.capabilityRef` is populated only when
`capabilities.enabled=true` on the operator chart. The audit-stamps
scenario (80) does not depend on caps for its label / annotation
projection, but the cap mint event is the headline GA signal. Operators
running with `capabilities.enabled=false` should:

- enable capabilities at minimum for the duration of the RC capture;
- or accept that `capabilityRef` reads "missing" on every task and
  flag it on the reviewer sign-off.

### 7.5 Cap-gated spawn

The Acceptance Gates list "at least one cap-gated task has
`status.capabilityRef`, a mounted Secret-backed JWT, a
`capability.minted` audit event, and a successful `capability.used`
event when spawn is exercised". The bundle exercises spawn via the
delegation scenario (40); confirming the `capability.used` audit
requires inspecting the NATS audit stream (subject `audit.>`) — which
is OUT OF SCOPE for the workbench-only evidence pack. Note in the
reviewer sign-off that NATS-side audit verification is a separate
artifact (a `nats stream view audit` capture) when the install runs
with `audit.enabled=true`.
