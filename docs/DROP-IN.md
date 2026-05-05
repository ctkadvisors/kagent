# Drop-in deployment guide

**Date:** 2026-05-05
**Status:** Working draft for `v0.1.6-ga-hardening.5` — answers the single question "what does an operator need before `helm install kagent` succeeds on an arbitrary K3s (or generic Kubernetes) cluster?"
**License:** MIT

> Read [`README.md`](../README.md), [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md), and [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) first if you have not. This document is the install-side contract those documents imply.

---

## 1. TL;DR

kagent is the K3s-native agent farm operator: a TypeScript Kubernetes operator that watches `Agent` + `AgentTask` CRDs and materializes per-task `Job`s running the in-pod `@kagent/agent-pod` runtime. The substrate it composes — capabilities, tenancy, workspaces, content-addressed artifacts, supervision, workflows, events, blackboard, cache, identity, locality, egress, quotas, versioning, key rotation — is shipped as a single Helm chart whose feature gates default OFF, so a minimal install is meant to land on any reasonably current Kubernetes cluster without taking a hard dependency on the rest of the stack.

**Minimal mode** (the default `helm install` posture): operator + CRDs + workbench + an OpenAI-compat model gateway URL — no NATS, no SPIRE, no tenancy, no workspaces, no audit. AgentTasks land in the release namespace, the agent loop talks to the gateway directly, and traces drop on the floor unless you wire OTLP. **Full mode** (recommended for production / multi-tenant deployments) layers in NATS JetStream (audit + events + blackboard), Langfuse (traces + prompt management), an RWX `StorageClass` (Workspaces / CAS), SPIRE (per-pod SVIDs), a CNI that enforces NetworkPolicy (egress), and cert-manager (versioning admission webhook). The chart turns each on with one Helm value; the prereqs each implies are listed in §3.

---

## 2. Cluster prerequisites

| Prerequisite | Required | Source |
|---|---|---|
| Kubernetes ≥ 1.27 (K3s, GKE, EKS, AKS, kind) | always | `README.md` line 7 |
| Helm 3.x | always | standard |
| `kubectl` access with cluster-admin (CRD + ClusterRole install) | always | `templates/clusterrole.yaml` |
| RuntimeClass `kata` on every node that schedules `sandboxProfile: strict` Agents | only when `agentPod.runtimeClasses.strict: 'kata'` | `values.yaml` §`agentPod.runtimeClasses` |
| RWX-capable `StorageClass` | when `workspaces.enabled`, `agentPod.artifactStorage.enabled`, or `cas.enabled` | `values.yaml` §`workspaces`, §`agentPod.artifactStorage`, §`cas` |
| CNI that enforces NetworkPolicy (Calico, Cilium, Weave) | when `networkPolicy.enabled: true` (default) or `egress.enabled: true` | `values.yaml` §`networkPolicy`; `chart README.md` §"NetworkPolicy" |
| cert-manager `Issuer` in the release namespace | when `versioning.enabled: true` | `values.yaml` §`versioning.webhook.certIssuer` |

### CRD installation order

The chart ships nine CRDs under `packages/operator/charts/kagent-operator/crds/`:

```
agent.yaml
agentcapability.yaml
agenttask.yaml
agenttemplate.yaml
agentworkflows.yaml
kagent-schedule.yaml
modelendpoint.yaml
tenants.yaml
workspaces.yaml
```

Helm installs CRDs from `crds/` once on first install (and never on upgrade — Helm's design). For installs that share CRD lifecycle separately (ArgoCD apps, GitOps with a CRDs-only Application), apply `packages/operator/manifests/crds/` first and disable CRD install on the chart.

### RBAC needs

The chart provisions one cluster-scoped `ClusterRole` + `ClusterRoleBinding` (`templates/clusterrole.yaml`). It is required because:

1. The operator watches Agents / AgentTasks cluster-wide for the trigger + workflow primitives, even when `watchAllNamespaces: false`. The default deployment template still scopes the CR-create path to the release namespace via `KAGENT_WATCH_NAMESPACE`.
2. The operator manages `Job`, `Pod`, `Event`, `ConfigMap`, `PersistentVolumeClaim`, `Service`, `Deployment`, and `Secret` resources in the AgentTask's namespace.
3. Wave-gated permissions live in the same ClusterRole and are inert unless the corresponding controllers boot (workspace, workflows, identity, tenancy, egress, versioning, key-rotation).

A second `ServiceAccount` + namespace-scoped `Role`/`RoleBinding` (`kagent-agent-pod`) is provisioned by `agentPod.rbac.create: true` (default) so spawned agent pods can `patch` their own `AgentTask.status` and (when WS-K spawn-child is on) `create` child `agenttasks`.

### Namespace conventions

- Release namespace defaults to `kagent-system` per `values-references/README.md` and the operator's chart README. NATS / LiteLLM / Langfuse Service URLs in the chart defaults assume that namespace; override the URLs explicitly when you install elsewhere.
- `watchNamespace: ''` means "watch the release namespace." Set `watchAllNamespaces: true` only after you have provisioned the `kagent-agent-pod` ServiceAccount + the artifact PVC in every workload namespace.

### RuntimeClass (Kata) optionality

`agentPod.runtimeClasses.{default,strict}` map `Agent.spec.sandboxProfile` to a `RuntimeClass`. Both default to `''` (no `runtimeClassName` set on the spawned pod = cluster default, typically `runc`). Set `agentPod.runtimeClasses.strict: 'kata'` only after installing Kata Containers onto the nodes that will schedule strict-profile Agents — otherwise those pods fail to schedule with a missing-RuntimeClass error.

---

## 3. External services required by mode

Three columns: services kagent itself depends on whenever it boots, services it requires only when a specific feature gate is ON, and services that are purely optional.

| Service | Always required | Required when feature gate ON | Optional |
|---|---|---|---|
| OpenAI-compat model gateway | yes (any URL that satisfies [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §2) | — | — |
| NATS JetStream (single-node ok in v0.1; HA in v0.2) | — | `audit.enabled` (default true), `events.enabled`, `blackboard.enabled` (default true), `triggers.enabled`, real `KAGENT_NATS_URL` dispatcher | — |
| RWX object/PVC storage | — | `workspaces.enabled`, `agentPod.artifactStorage.enabled` (default true; defaults to `ai-models-storage` SC — override for non-homelab), `cas.enabled`, `cache.enabled` | — |
| Langfuse (or any OTLP/HTTP traces sink) | — | `langfuse.enabled` (Langfuse-managed system prompts) — also OTLP traces flow whenever `agentPod.otlpEndpoint` is set, no `enabled` flag | — |
| SPIRE (server + agent DaemonSet) | — | `identity.enabled` (chart bundles a SPIRE sub-chart at `charts/spire/` that renders only when `identity.enabled: true`) | — |
| CNI with NetworkPolicy enforcement | — | `networkPolicy.enabled` (default true) — chart renders the policy on every install but K3s-default flannel ignores it; `egress.enabled` for per-Agent enforcement | — |
| cert-manager | — | `versioning.enabled` (the validating admission webhook needs a serving cert) | — |
| Restate | — | `workflows.enabled` (operator does not install Restate; install it separately and point `workflows.restate.address` at it) | — |
| Postgres / ClickHouse / Redis | — | bundled with the Langfuse Helm chart — only if you stand up Langfuse | — |
| LiteLLM | — | — | drop-in OpenAI-compat gateway when you do not have a managed gateway; `agentPod.litellmBaseUrl` defaults to it at `http://litellm.kagent-system.svc.cluster.local:4000/v1` |

The model gateway is the only **always**-required external service. Everything else gates on a Helm value.

---

## 4. Secrets you must create before install

Provision these as `kubectl create secret generic ...` (or Sealed-Secrets / ExternalSecrets) in the **release namespace** before `helm install`. The chart never creates them for you.

| Secret name (suggested) | Key(s) | Referenced by | When |
|---|---|---|---|
| `cloudflare-ai-gateway` (or whatever you choose) | `api-key` | `agentPod.litellmApiKey.secretName` + `.secretKey` | always — gateway bearer token |
| `langfuse-otlp-headers` | `headers` (e.g. `authorization=Bearer%20<pk>,x-langfuse-ingestion-version=4`) | `agentPod.otlpHeaders.secretName` + `.secretKey` | when emitting traces to Langfuse 4.x |
| `langfuse-api-keys` | `public`, `secret` | `langfuse.apiKey.secretName` + `.publicKeyKey` + `.secretKeyKey` | when `langfuse.enabled: true` (system-prompt fetch) |
| `kagent-llm-gateway-token` | `token` | `llmGateway.apiKey.secretName` + `.secretKey` | when `llmGateway.enabled: true` |
| `kagent-cap-signing-key` | `tls.key`, `tls.crt`, optional second-pubkey for grace | `capabilities.signingSecretName` + `.signingKeyKey` + `.signingPublicKeyKey` + `.previousPublicKeyKey` | when `capabilities.enabled: true` |
| `<release>-trigger-secrets` (auto-named from values) | one key per trigger id | `triggers.secrets` map → chart materializes the Secret | when `triggers.enabled: true` and you declare HMAC-signed webhook triggers |

NATS audit + events use a `KAGENT_AUDIT_NATS_URL` / `KAGENT_NATS_URL` URL; if your NATS exposes auth, encode it in the URL or extend the deployment template to mount creds. The defaults assume in-cluster NATS without auth, matching `values-references/nats-jetstream.yaml`.

**Plaintext escape-hatch:** every secret-ref key has a deprecated sibling `value:` (plaintext). The chart still renders it but `templates/NOTES.txt` prints a warning banner because the plaintext leaks into the operator's PodSpec and every spawned Job's etcd object. Always use the secret-ref form in production.

---

## 5. Five-minute minimal install rubric

Goal: a healthy operator + workbench, the smoke-test Agent + AgentTask running through an external OpenAI-compat endpoint, no NATS / SPIRE / tenancy / workspaces.

```bash
# 1. Provision the gateway bearer-token Secret in the target namespace.
kubectl create namespace kagent-system
kubectl -n kagent-system create secret generic cloudflare-ai-gateway \
  --from-literal=api-key='sk-...'

# 2. Install the operator chart with the smoke-test toggle on.
helm install kagent ./packages/operator/charts/kagent-operator \
  --namespace kagent-system \
  --set agentPod.litellmBaseUrl='https://gateway.example.com/v1' \
  --set agentPod.litellmApiKey.secretName=cloudflare-ai-gateway \
  --set agentPod.litellmApiKey.secretKey=api-key \
  --set audit.enabled=false \
  --set blackboard.enabled=false \
  --set agentPod.artifactStorage.enabled=false \
  --set networkPolicy.enabled=false \
  --set smokeTest.enabled=true \
  --set smokeTest.model='gpt-4o-mini' \
  --set smokeTest.prompt='In one sentence, what is K3s?'

# 3. Watch the smoke-test verify Job — exits 0 on Completed, 1 on timeout.
kubectl -n kagent-system logs -f job/smoke-test-verify-r1
```

What this flips off and why:

- `audit.enabled=false` skips the NATS audit-stream provisioning Job. Default is `true` and assumes a NATS Service at `nats.kagent-system.svc.cluster.local:4222`; flipping it off means no NATS install required.
- `blackboard.enabled=false` skips the per-task-tree NATS KV bucket plumbing. Same reason.
- `agentPod.artifactStorage.enabled=false` skips the `kagent-artifacts` PVC. Default targets the homelab `ai-models-storage` RWX class which doesn't exist on a generic cluster.
- `networkPolicy.enabled=false` is the safety belt for clusters whose CNI doesn't enforce policies (default K3s flannel). The chart renders an enforced policy by default; disabling avoids cargo-culted resources on non-enforcing CNIs.

Workbench install (separate chart; same namespace):

```bash
helm install kagent-workbench ./packages/operator/charts/kagent-workbench \
  --namespace kagent-system \
  --set api.authRequired='false'   # ONLY for first-bringup smoke; flip back to 'true' in production
```

The workbench's `X-Forwarded-User` requirement (header-trust auth gate per `WORKBENCH.md` §6) defaults ON. Production deployments front the workbench with Traefik forward-auth or oauth2-proxy and leave `authRequired: 'true'`.

---

## 6. Production install rubric

Same chart, with capabilities + tenancy + audit + key rotation enabled. Each toggle implies one or more prereqs from §3 — listed inline.

Prerequisites (provision before `helm install`):

1. **NATS JetStream** in `kagent-system` per `values-references/nats-jetstream.yaml` (single-node v0.1; cluster-mode v0.2). The chart's audit-stream provisioning Job calls `nats stream add/update` against `nats://nats.kagent-system.svc.cluster.local:4222`.
2. **Langfuse 4.x** per `values-references/langfuse.yaml` if you want trace + prompt-management; create a project and stash the public/secret API keys in `langfuse-api-keys` and an OTLP-headers Secret.
3. **An RWX `StorageClass`** (Longhorn / NFS / Ceph / cloud RWX with topology). Workspaces + CAS both require it.
4. **A capability signing keypair** in `kagent-cap-signing-key`:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out cap.key
   openssl ec -in cap.key -pubout -out cap.crt
   kubectl -n kagent-system create secret generic kagent-cap-signing-key \
     --from-file=tls.key=cap.key --from-file=tls.crt=cap.crt
   ```
5. **Tenant CRs** for each tenant boundary you intend to enforce — see `templates/NOTES.txt` lines 146–211 for the exact shape and the cross-tenant K8s RBAC overlay the cluster admin must compose.
6. **A CNI that enforces NetworkPolicy** (Calico / Cilium / Weave). K3s default flannel does not.

```bash
helm install kagent ./packages/operator/charts/kagent-operator \
  --namespace kagent-system \
  --values values.production.yaml
```

Where `values.production.yaml` looks like:

```yaml
agentPod:
  litellmBaseUrl: 'https://gateway.example.com/v1'
  litellmApiKey:
    secretName: kagent-llm-gateway-token
    secretKey: token
  otlpEndpoint: 'http://langfuse-web.kagent-system.svc.cluster.local:3000/api/public/otel/v1/traces'
  otlpHeaders:
    secretName: langfuse-otlp-headers
    secretKey: headers
  artifactStorage:
    enabled: true
    storageClassName: longhorn
    accessMode: ReadWriteMany

audit:
  enabled: true
  natsUrl: 'nats://nats.kagent-system.svc.cluster.local:4222'

events:
  enabled: true

blackboard:
  enabled: true

workspaces:
  enabled: true
  defaultStorageClassName: longhorn

cas:
  enabled: true
  pvcName: kagent-cas

capabilities:
  enabled: true
  signingSecretName: kagent-cap-signing-key
  signingKeyKey: tls.key
  signingPublicKeyKey: tls.crt

tenancy:
  enabled: true
  defaultTenant: ''      # strict — every Agent must declare its tenant

egress:
  enabled: true
  mode: auto             # auto-detects Cilium; falls back to plain NetworkPolicy

quotas:
  enabled: true

versioning:
  enabled: true
  webhook:
    certIssuer: kagent-cert-issuer
    certIssuerKind: Issuer

keyRotation:
  enabled: true
  svid:
    intervalHours: 24
  cap:
    shortTtlMinutes: 60

langfuse:
  enabled: true
  apiKey:
    secretName: langfuse-api-keys
    publicKeyKey: public
    secretKeyKey: secret

networkPolicy:
  enabled: true
```

Identity (`identity.enabled: true`) is intentionally not in the example above — flip it on after validating SPIRE health on a separate cluster or via `identity.mock.enabled: true` first. SPIRE's `kagent-spire` Workload-API socket layout lives at `hostPath: /run/kagent-spire/sockets` and the chart's sub-chart provisions the StatefulSet + DaemonSet.

---

## 7. Known sharp edges

- **Bun runtime workaround for K3s self-signed CA.** Both `packages/operator` and `packages/agent-pod` images are built on **Node 22 + tsx**, not Bun. Bun 1.1's TLS handling rejects K3s's self-signed CA when `@kubernetes/client-node` opens its watch / status-PATCH paths; the same kubeconfig works in Node, breaks in Bun. Bun is the v0.2 target once undici/TLS parity lands. See `Dockerfile` comments at `packages/operator/Dockerfile` + `packages/agent-pod/Dockerfile` and the README §3.
- **ConfigMap vs env JSON spec injection.** v0.2.0-typed-io replaced the `KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC` env-JSON path with a per-Job `ConfigMap` carrying `agent.spec.json` + `task.spec.json` (closes the ARG_MAX cap and the ps-visible env-string leak). The operator owns the ConfigMap via `ownerReferences` so `AgentTask` deletion cascades. ClusterRole grants `configmaps: [get,list,watch,create,delete]` for this; the explicit `delete` verb sweeps orphans on next reconcile.
- **K3s flannel ignores NetworkPolicies silently.** `networkPolicy.enabled: true` is the default but K3s default flannel installs the policy resource and treats it as a no-op. Either deploy K3s with `--flannel-backend=none` + Calico, or set `networkPolicy.enabled: false` and accept the risk.
- **Single replica only in v0.1.** The chart hard-fails at `helm template` time on `replicaCount != 1`. Multi-replica needs leader election (v0.2). Strategy is pinned to `Recreate` so rolling updates never have two replicas live.
- **Helm leaves CRDs in place on uninstall.** Standard Helm CRD lifecycle. Drop manually with `kubectl delete crd ...kagent.knuteson.io` if you want a full teardown — destructive, cascades to all CRs.
- **`crds/` is a copy.** `packages/operator/charts/kagent-operator/crds/` is hand-mirrored from `packages/operator/manifests/crds/`. Update both.
- **`watchAllNamespaces: true` requires per-namespace prereqs.** The `kagent-agent-pod` ServiceAccount + the artifact PVC are namespace-local — without them in every workload namespace, spawned Jobs fail to schedule.
- **`langfuse.enabled: true` without `langfuse.apiKey.secretName`** boots the Langfuse-managed prompt fetcher path but every spawned Job's prompt fetch will fail. NOTES.txt prints a banner; provision the Secret first.
- **Versioning webhook needs cert-manager.** `versioning.failurePolicy: Fail` is stricter than the K8s default `Ignore`. Flip to `Ignore` only during initial cert provisioning when the webhook is not yet healthy.
- **SMB/NFS-backed RWX size caps are advisory.** `agentPod.artifactStorage.size: 10Gi` is the StorageClass-honored upper bound at provisioning time; the underlying share's free space is the real cap.

---

## 8. What kagent does NOT install for you

Per `CLAUDE.md` §"What this repo does NOT do":

- **No agent SDK.** Agents inside pods run any framework (Strands TS, Mastra, the forked AgentExecutor); the substrate is framework-agnostic.
- **No LLM gateway.** Use LiteLLM (Helm chart at `berriai/litellm`; reference values at `values-references/litellm.yaml`), Cloudflare AI Gateway, OpenRouter, or any OpenAI-compat endpoint that satisfies [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md).
- **No trace store.** Use Langfuse (Helm chart at `langfuse/langfuse`; reference values at `values-references/langfuse.yaml`) or any OTLP/HTTP traces sink.
- **No Kubernetes-management agent.** That is `kagent.dev` (Solo.io), an unrelated project — different problem domain.
- **No cluster manifests.** On the homelab, `new_localai/` is the GitOps repo; on cloud, your cluster's IaC is the install layer. The chart in this repo is consumed as an upstream dependency.
- **No workflow / DAG / Swarm engine.** A2A messaging is at the primitive level (NATS subjects, blackboard KV); topology is application-layer.
- **No NATS / Langfuse / LiteLLM / SPIRE / cert-manager / Restate as bundled sub-charts.** The reference values at `packages/operator/charts/values-references/` are documentation, not deployable sub-charts. Tenant-scoping, upgrade independence, and homelab-vs-cloud variance all argue against bundling.

### GitOps hand-off

On the homelab K3s cluster, ArgoCD owns the install. The pattern is one ArgoCD `Application` per layer (NATS → LiteLLM → Langfuse → kagent-operator → kagent-workbench), each pointing at the upstream chart + the appropriate `values-references/*.yaml` (or an inline override). Per `CLAUDE.md` operational context, the homelab is GitOps-only — never reach for imperative `kubectl apply/exec/port-forward` on it. Verification ships as Job manifests, not as ad-hoc commands.
