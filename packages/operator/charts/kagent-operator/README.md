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
- **Kata Containers node-side install** (Phase 6 / v0.2): the operator-side wiring is shipped — `Agent.spec.sandboxProfile: 'strict'` resolves through `agentPod.runtimeClasses.strict` to a per-pod `runtimeClassName`. The remaining work is deploying Kata onto the K3s nodes via the Kata K8s deployer (see `docs/ROADMAP.md` Phase 6); only flip `agentPod.runtimeClasses.strict: 'kata'` once that's done, otherwise strict-profile agents will fail to schedule with a missing-RuntimeClass error.

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
| `agentPod.runtimeClasses.default` | `''`                                              | RuntimeClass for `Agent.spec.sandboxProfile=default` (or absent). `''` = cluster default (typically `runc`). |
| `agentPod.runtimeClasses.strict`  | `''`                                              | RuntimeClass for `Agent.spec.sandboxProfile=strict`. Set to `'kata'` AFTER Kata is deployed onto the nodes (Phase 6); `''` falls back to cluster default. |
| `resources.requests`           | `{ cpu: 50m, memory: 128Mi }`                        | Operator-pod requests                              |
| `resources.limits`             | `{ cpu: 500m, memory: 256Mi }`                       |                                                    |
| `replicaCount`                 | `1`                                                  | Single-replica only in v0.1                        |

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
