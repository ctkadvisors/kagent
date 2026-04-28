# kagent-operator Helm chart

Deploys the [kagent](https://github.com/ctkadvisors/kagent) operator + the three v1alpha1 CRDs (`Agent`, `AgentTask`, `AgentCapability`).

## Install

```bash
helm install kagent ./packages/operator/charts/kagent-operator \
  --namespace kagent-system \
  --create-namespace
```

The operator runs cluster-wide; the chart only allocates a namespace for the operator's Pod itself.

## Phase 2 boundary

This is `v0.0.2-phase2`. The operator:

1. Watches `AgentTask` cluster-wide
2. Resolves the target `Agent` (by name)
3. Creates a `Job` running `@kagent/agent-pod` (placeholder image in v0.0.2)
4. Publishes a stub dispatch envelope (`StubDispatcher`)
5. Patches `AgentTask.status.phase = Dispatched`

What's **not** wired yet:

- **Real agent-pod runtime** (Phase 3): the placeholder container exits immediately. Status will not progress past `Dispatched` until Phase 3 ships `@kagent/agent-pod`.
- **NATS A2A bus** (Phase 3): `StubDispatcher` is in-memory only.
- **Capability resolution** (Phase 3): `targetCapability` fast-fails today.
- **Kata Containers** (v0.2): `Agent.spec.sandboxProfile: 'strict'` is parsed but not yet plumbed to `runtimeClassName`.

## Values

See `values.yaml` for the full surface. Key knobs:

| Key                            | Default                                              | Notes                                              |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------- |
| `image.repository`             | `ghcr.io/ctkadvisors/kagent-operator`                | Operator container image                           |
| `image.tag`                    | `''` (defaults to `Chart.appVersion`)                |                                                    |
| `imagePullSecrets`             | `[]`                                                 | e.g. `[{ name: ghcr-pull }]` for private registry  |
| `agentPod.image.repository`    | `ghcr.io/ctkadvisors/kagent-agent-pod`               | Container the operator spawns per AgentTask        |
| `agentPod.image.tag`           | `v0.0.2-phase2-stub`                                 | Placeholder until Phase 3 ships real runtime image |
| `agentPod.serviceAccountName`  | `''`                                                 | SA each agent pod runs under                       |
| `resources.requests`           | `{ cpu: 50m, memory: 128Mi }`                        | Operator-pod requests                              |
| `resources.limits`             | `{ cpu: 500m, memory: 256Mi }`                       |                                                    |
| `replicaCount`                 | `1`                                                  | Single-replica only in v0.1                        |

## Secret refs for the LiteLLM API key + OTLP headers

WS-A (security baseline) flips both `agentPod.litellmApiKey` and
`agentPod.otlpHeaders` from plain strings to a `{secretName, secretKey, value}` shape. Prefer secret-ref:

```yaml
agentPod:
  litellmApiKey:
    secretName: cloudflare-ai-gateway
    secretKey: api-key
  otlpHeaders:
    secretName: langfuse-otlp-headers
    secretKey: headers # comma-joined: 'authorization=Bearer%20<pk>,...'
```

Provision the underlying Secrets via `kubectl create secret generic` or
Sealed-Secrets (Argo-friendly). The operator container env is sourced
via `valueFrom.secretKeyRef`, so the plaintext never lands in the
operator's PodSpec.

The `value` (plaintext) field still renders the env directly and keeps
back-compat working. Setting `value` triggers a deprecation warning in
`helm install` / `helm upgrade` output (NOTES.txt).

## Uninstall

```bash
helm uninstall kagent --namespace kagent-system
```

Helm leaves CRDs in place by design (CRD removal is destructive — cascades to all CRs of that kind). Remove manually if desired:

```bash
kubectl delete crd agents.kagent.knuteson.io agenttasks.kagent.knuteson.io agentcapabilities.kagent.knuteson.io
```

## Source-of-truth note for CRDs

The `crds/` directory in this chart is a copy of `packages/operator/manifests/crds/`. If you update one, mirror the change to the other (or apply the manifests directly without Helm). They're kept in sync manually rather than via build script for v0.1 simplicity.
