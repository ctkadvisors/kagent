# kagent-workbench Helm chart

Operator console over the [kagent](https://github.com/ctkadvisors/kagent) control plane. Surfaces `Agent`, `AgentTask`, `AgentCapability`, and the operator-owned `Job`s/`Pod`s through a thin API facade (`kagent-workbench-api`) plus a React/Vite UI (`kagent-workbench-ui`) sidecar. The default read surface is write-proof; create/review/Architect writes are gated behind the separate `rbac.actions.create` values path.

This chart is the **deployment** surface. The `workbench-api` and `workbench-ui` packages live in the same kagent monorepo (`packages/workbench-api/`, `packages/workbench-ui/`). The chart references them by image name only — see [`values.yaml`](./values.yaml).

See [`docs/WORKBENCH.md`](../../../../docs/WORKBENCH.md) for the design and [`new_localai/docs/kagent-workbench-rbac.md`](../../../../../new_localai/docs/kagent-workbench-rbac.md) for the RBAC + auth plan this chart implements.

## What it deploys

A single Pod with two containers, plus the supporting RBAC / Service / optional Ingress:

| Resource              | Name                          | Notes                                                                |
| --------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `Deployment`          | `<release>-kagent-workbench`  | api + ui sidecar; api owns the K8s creds, ui is a static-asset image |
| `Service` (ClusterIP) | `<release>-kagent-workbench`  | port 80 → api 8080, port 81 → ui 8081 (debug only)                   |
| `ServiceAccount`      | `kagent-workbench` (default)  | bound to the read-only ClusterRole below                             |
| `ClusterRole`         | `<fullname>-reader`           | get/list/watch on kagent CRDs + Jobs + Pods + Events; **no writes**  |
| `ClusterRoleBinding`  | `<fullname>-reader`           | binds the SA to the reader ClusterRole                               |
| `Role`                | `<fullname>-actions`          | optional release-namespace write surface when `rbac.actions.create=true` |
| `RoleBinding`         | `<fullname>-actions`          | binds the SA to the action Role                                      |
| `Role`                | `<fullname>-architect-draft`  | optional cross-namespace Architect draft writer                      |
| `RoleBinding`         | `<fullname>-architect-draft`  | binds the release SA into the draft namespace                        |
| `Ingress` _or_        | `<release>-kagent-workbench`  | rendered when `ingress.enabled=true` and `ingress.authMiddleware=''` |
| `IngressRoute`        | `<release>-kagent-workbench`  | rendered when `ingress.enabled=true` and `ingress.authMiddleware!='` |

The `ui` container is a sidecar (nginx-alpine baking the Vite `dist/` build), not a separate Deployment. The `api` container proxies non-`/api` requests to the sidecar over loopback. Lifecycle is coupled (no UI without API), and the network hop is loopback-only — one Pod is the right unit.

**RBAC is split by function.** The reader ClusterRole has no write verbs. Write actions live in a separate namespaced Role keyed off `rbac.actions.create`; Architect cross-namespace drafts add a second namespaced Role only when `api.architect.draftNamespace` differs from the release namespace.

## Install

```bash
helm install kagent-workbench ./packages/operator/charts/kagent-workbench \
  --namespace kagent-system \
  --create-namespace
```

The workbench expects to live in the **same namespace as the operator** so it shares the operator's image-pull setup (the chart's defaults pull from `ghcr.io/ctkadvisors/...` public packages — no pull secret needed). On a fresh cluster, install the operator first (`packages/operator/charts/kagent-operator`) — the workbench reads the CRDs the operator installs.

Verify after install:

```bash
kubectl --namespace kagent-system port-forward \
  svc/kagent-workbench-kagent-workbench 8080:80

curl -fsS http://localhost:8080/healthz
```

## Values reference

| Key                            | Default                                              | Notes                                                              |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `replicaCount`                 | `1`                                                  | Single replica is fine for MVP — state is rebuilt from the API server on restart. |
| `api.image.repository`         | `ghcr.io/ctkadvisors/kagent-workbench-api`           | workbench-api image. Public ghcr.io package — no pull secret.       |
| `api.image.tag`                | `''` (defaults to `Chart.appVersion`)                | Pin in dev with `--set api.image.tag=...`.                         |
| `api.image.pullPolicy`         | `IfNotPresent`                                       | ghcr.io tags are immutable per release. Set `Always` for moving tags. |
| `api.port`                     | `8080`                                               | Container port the api listens on.                                 |
| `api.healthPath`               | `/healthz`                                           | Liveness + readiness probe path. Owned by the workbench-api package. |
| `api.langfuseBaseUrl`          | `''`                                                 | Optional. Plumbed as `LANGFUSE_BASE_URL`; reserved for "open trace" links. |
| `api.authRequired`             | `'true'`                                             | Fail-closed header-trust auth. Only literal `false` disables it.   |
| `api.architect.enabled`        | `false`                                             | Mount `/api/architect/*` when gateway URL, model, and token Secret are configured. |
| `api.architect.draftNamespace` | `''`                                                | Empty defaults drafts to the Helm release namespace. Set `kagent-draft` for a separate live-iteration namespace. |
| `api.architect.draftRbac.create` | `true`                                            | When drafts use a separate namespace, render the workbench writer Role/RoleBinding there. |
| `api.resources`                | `50m / 128Mi → 500m / 256Mi`                         | Bump when watching many AgentTasks.                                |
| `ui.image.repository`          | `ghcr.io/ctkadvisors/kagent-workbench-ui`            | workbench-ui static-asset image. Public ghcr.io package.            |
| `ui.image.tag`                 | `''` (defaults to `Chart.appVersion`)                |                                                                    |
| `ui.image.pullPolicy`          | `IfNotPresent`                                       |                                                                    |
| `ui.port`                      | `8081`                                               | Sidecar nginx-alpine bind port.                                    |
| `ui.healthPath`                | `/`                                                  | nginx-alpine default 200 surface.                                  |
| `ui.resources`                 | `10m / 32Mi → 100m / 64Mi`                           | Static file server — tiny.                                         |
| `imagePullSecrets`             | `[]`                                                 | None needed for ghcr.io public packages. Add `[{ name: ... }]` for private mirrors. |
| `serviceAccount.create`        | `true`                                               | Set false to bind a pre-existing SA via `serviceAccount.name`.     |
| `serviceAccount.name`          | `kagent-workbench`                                   | Empty → defaults to the chart fullname.                            |
| `serviceAccount.annotations`   | `{}`                                                 |                                                                    |
| `rbac.create`                  | `true`                                               | Cluster-scoped read-only ClusterRole + binding.                    |
| `rbac.actions.create`          | `true`                                               | Namespaced write Role for task creation, reviews, gateway edits, and release-namespace Architect `/try`. |
| `service.type`                 | `ClusterIP`                                          |                                                                    |
| `service.port`                 | `80`                                                 | Service-side API port targeting the api container's named port.     |
| `service.uiPort`               | `81`                                                 | Service-side UI port targeting the ui sidecar's named port; debug/port-forward only. |
| `ingress.enabled`              | `false`                                              | See "Ingress + auth recipe" below.                                 |
| `ingress.className`            | `traefik`                                            | Used on the vanilla Ingress path; informational on the IngressRoute path. |
| `ingress.host`                 | `''`                                                 | REQUIRED when `enabled=true`. Hostname (e.g. `kagent.knuteson.io`).|
| `ingress.tls.secretName`       | `''`                                                 | TLS secret name; both render paths honor this.                     |
| `ingress.authMiddleware`       | `''`                                                 | Non-empty → render Traefik IngressRoute with this Middleware.      |
| `ingress.annotations`          | `{}`                                                 | Free-form annotations on the rendered Ingress / IngressRoute.      |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}`                      | Standard placement.                                                |
| `podAnnotations` / `podLabels` | `{}` / `{}`                                          | Pod-level extras.                                                  |
| `logLevel`                     | `info`                                               | Plumbed as `LOG_LEVEL` into the api container.                     |
| `nameOverride` / `fullnameOverride` | `''` / `''`                                     | Standard Helm idiom.                                               |

## Ingress + auth recipe

This chart's `ingress.yaml` template renders **two different resource kinds** depending on `ingress.authMiddleware`:

### Recipe A — Tailscale-only (preferred for first cut)

Bind the workbench to a `*.homelab` hostname. No public DNS, no public TLS — accessible only over the existing Tailscale VPN. Mirrors how `argocd.homelab`, `git.homelab`, etc. are reached today.

```yaml
ingress:
  enabled: true
  host: kagent.homelab
  className: traefik
  tls:
    secretName: '' # no TLS — Tailscale is the boundary
  authMiddleware: '' # no auth Middleware — Tailscale is the boundary
```

This renders a vanilla `networking.k8s.io/v1 Ingress`. The lowest-risk default for an operator-console UI in the read-only MVP.

### Recipe B — Public DNS with Traefik basicAuth Middleware

Bind to a `*.knuteson.io` hostname under the wildcard `knuteson-tls` Certificate. Put a basicAuth Middleware in front. Sufficient for a single-operator homelab — not multi-tenant production, but explicit and auditable.

```yaml
ingress:
  enabled: true
  host: kagent.knuteson.io
  className: traefik
  tls:
    secretName: knuteson-tls # cert-manager wildcard *.knuteson.io
  authMiddleware: kagent-workbench-basic-auth
```

This renders a `traefik.io/v1alpha1 IngressRoute` referencing the named Middleware.

The Middleware itself is **not** created by this chart. Provision it out-of-band with a Sealed-Secret-backed `basicAuth` Middleware in the Release namespace:

```yaml
# Provisioned via secrets.knuteson.io Sealed-Secrets UI in
# the kagent-system namespace, separately from this chart.
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: kagent-workbench-basic-auth
  namespace: kagent-system
spec:
  basicAuth:
    secret: kagent-workbench-basic-auth-htpasswd # SealedSecret
```

### Recipe C — Future shared SSO

When the homelab grows a shared SSO (oauth2-proxy in front of Authentik or similar), `ingress.authMiddleware` just changes to point at the shared `forwardAuth` Middleware (likely in `ingress-system`). No chart change required.

## RBAC scope

Cluster-scoped read-only. The exact verbs are documented inline in [`templates/clusterrole.yaml`](./templates/clusterrole.yaml). Summary:

| Resource group                                       | Verbs                |
| ---------------------------------------------------- | -------------------- |
| `kagent.knuteson.io/{agents,agenttasks,agentcapabilities}` | `get,list,watch`     |
| `kagent.knuteson.io/{agents,agenttasks,agentcapabilities}/status` | `get`                |
| `batch/jobs`                                         | `get,list,watch`     |
| `pods`                                               | `get,list,watch`     |
| `pods/log`                                           | `get`                |
| `events` (core + `events.k8s.io`)                    | `get,list,watch`     |

`Pod` and `Job` reads are cluster-wide because the operator runs cluster-scoped. The workbench-api filters on the label `kagent.knuteson.io/managed-by=kagent-operator` in code — the API code is the trust boundary for selector enforcement, since RBAC at the Kubernetes layer cannot scope by label.

The reader ClusterRole has no write verbs. The optional actions Role is release-namespace scoped and grants only the write verbs needed by implemented API actions:

| Resource group                                              | Verbs              | Surface |
| ----------------------------------------------------------- | ------------------ | ------- |
| `kagent.knuteson.io/agenttasks`                             | `create,patch`     | create-task + review annotations |
| `kagent.knuteson.io/agenttemplates`                         | `create`           | review promotion + Architect `/try` |
| `kagent.knuteson.io/agents`                                 | `create`           | Architect `/try` when drafts use the release namespace |
| `kagent.knuteson.io/modelendpoints`                         | `patch,update`     | Gateway bounds edits |

When `api.architect.draftNamespace` is set to a namespace other than the release namespace, `api.architect.draftRbac.create=true` renders a draft-namespace Role/RoleBinding for `agenttemplates`, `agents`, and `agenttasks`. The agent-pod runtime ServiceAccount/RBAC for that workload namespace is still provisioned by the operator chart or GitOps overlay.

## Auth (WS-A)

Header-trust auth is ENABLED by default (`api.authRequired: true`). The
workbench-api requires every non-probe request to carry an
`X-Forwarded-User` header (set upstream by Traefik forward-auth or
oauth2-proxy). `/healthz` and `/readyz` always bypass the gate so
kubelet probes still work without an auth shim.

Disable (dev / port-forward only): `--set api.authRequired=false`. The
container logs a loud warning at boot in that mode.

## NetworkPolicy (WS-A)

A default-deny NetworkPolicy is rendered at
`templates/networkpolicy.yaml` (gated by `networkPolicy.enabled`,
default `true`). It allows ingress only from the configured ingress
controller (defaults to a Traefik-friendly rule in
`ingress-controller` namespace) and egress to DNS + the Kubernetes API
server.

Override the ingress source for non-Traefik clusters:

```yaml
networkPolicy:
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
```

**CNI requirement.** K3s with the default `flannel` backend does NOT
enforce NetworkPolicies. Run K3s with `--flannel-backend=none` +
Calico/Cilium for enforcement, or accept that this resource is
documentation on a flannel cluster.

## Upgrade

```bash
helm upgrade kagent-workbench ./packages/operator/charts/kagent-workbench \
  --namespace kagent-system \
  --set api.image.tag=v0.0.6-workbench-mvp \
  --set ui.image.tag=v0.0.6-workbench-mvp
```

## Uninstall

```bash
helm uninstall kagent-workbench --namespace kagent-system
```

The chart owns no CRDs (the workbench is a client of the operator's CRDs, not a control plane of its own). Uninstall removes the Deployment, Service, RBAC, and Ingress only.
