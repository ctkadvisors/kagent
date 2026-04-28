# kagent-operator Helm chart

Deploys the [kagent](https://github.com/ctkadvisors/kagent) operator + the three v1alpha1 CRDs (`Agent`, `AgentTask`, `AgentCapability`).

## Install

```bash
helm install kagent ./packages/operator/charts/kagent-operator \
  --namespace kagent-system \
  --create-namespace
```

By default, the operator watches the release namespace. That matches the namespace-local
agent-pod ServiceAccount and artifact PVC this chart creates. Cluster-wide watch is still
available by setting `watchAllNamespaces: true`, but only after provisioning equivalent
agent-pod prerequisites in every workload namespace.

## v0.0.5 boundary

This chart deploys the v0.0.5 control plane:

1. Watches `AgentTask` in `watchNamespace`
2. Resolves the target `Agent` (by name)
3. Creates a `Job` running `@kagent/agent-pod`
4. Watches operator-managed Jobs/Pods for external failures
5. Plumbs built-in tool HTTP allowlists and artifact PVC settings into agent pods

What's **not** wired yet:

- **Capability resolution via live registry**: `targetCapability` still uses the stub registry in the default operator entrypoint.
- **Kata Containers** (v0.2): `Agent.spec.sandboxProfile: 'strict'` is parsed but not yet plumbed to `runtimeClassName`.

## Values

See `values.yaml` for the full surface. Key knobs:

| Key                            | Default                                              | Notes                                              |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------- |
| `image.repository`             | `ghcr.io/ctkadvisors/kagent-operator`                | Operator container image                           |
| `image.tag`                    | `''` (defaults to `Chart.appVersion`)                |                                                    |
| `imagePullSecrets`             | `[]`                                                 | e.g. `[{ name: ghcr-pull }]` for private registry  |
| `watchNamespace`               | `''` (deployment defaults to release namespace)      | Set explicitly for another namespace                         |
| `watchAllNamespaces`           | `false`                                              | Cluster-wide watch; requires per-namespace agent-pod prereqs |
| `agentPod.image.repository`    | `ghcr.io/ctkadvisors/kagent-agent-pod`               | Container the operator spawns per AgentTask        |
| `agentPod.image.tag`           | `''` (defaults to `Chart.appVersion`)                |                                                    |
| `agentPod.serviceAccountName`  | `kagent-agent-pod`                                   | SA each agent pod runs under                       |
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
