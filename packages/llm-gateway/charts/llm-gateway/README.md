# llm-gateway Helm sub-chart

Deploys the optional [kagent LLM Gateway](https://github.com/ctkadvisors/kagent) — a generic
OpenAI-compatible HTTP service that fronts the cluster's LLM backends with per-model
in-flight caps, AIMD self-tuning, and usage tracking.

This is a **sub-chart**: it ships under `packages/llm-gateway/charts/llm-gateway/` and is
intended to be deployed alongside or behind the kagent operator. See
[the design spec](../../../../docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md)
for the full architecture and decision log.

## When to install

The kagent operator works **without** the gateway — agents talk to backends
directly via the operator's `agentPod.litellmBaseUrl` value. Install this
chart when you want:

- Per-model in-flight caps (avoid stampeding a local Ollama at 50 concurrent calls)
- Centralized usage / cost / latency rows for cross-agent attribution
- AIMD self-tuning that converges on what your backend can actually serve
- A single OpenAI-compat endpoint regardless of upstream provider

## Two deployment modes

| Mode | Postgres source | When to use |
|---|---|---|
| **BYO** (default) | External Postgres via `database.dsnSecretRef` | Cloud (RDS / Cloud SQL / Aurora / Neon / Supabase) |
| **Bundled** | In-cluster Bitnami `postgresql` sub-chart | Homelab / quick dev / no managed Postgres available |

The gateway code path is identical in both modes — Postgres is the gateway's
private state and never coupled to kagent.

## Install — bundled Postgres (homelab)

```bash
helm dependency update packages/llm-gateway/charts/llm-gateway/

helm install llm-gateway packages/llm-gateway/charts/llm-gateway/ \
  --namespace kagent-system \
  --create-namespace \
  --set database.bundled=true \
  --set adminApiToken.secretName=llm-gateway-token
```

Pre-create the admin API token Secret first:

```bash
kubectl create secret generic llm-gateway-token \
  --namespace kagent-system \
  --from-literal=token="$(openssl rand -hex 32)"
```

The Bitnami `postgresql` sub-chart auto-generates a Postgres password into a
Secret on first install and persists across upgrades. The chart then
auto-creates the `<release>-llm-gateway-db` Secret holding the libpq DSN
that the gateway and migration Job both consume.

## Install — BYO Postgres (cloud)

Provision a Postgres database (RDS / Cloud SQL / Aurora / Neon / Supabase /
whatever) and create a Secret holding the DSN:

```bash
kubectl create secret generic external-pg \
  --namespace kagent-system \
  --from-literal=dsn="postgres://user:pass@db.example.com:5432/kagent_llm_gateway?sslmode=require"
```

Then install the chart pointing at it:

```bash
helm install llm-gateway packages/llm-gateway/charts/llm-gateway/ \
  --namespace kagent-system \
  --create-namespace \
  --set database.bundled=false \
  --set database.dsnSecretRef.name=external-pg \
  --set database.dsnSecretRef.key=dsn \
  --set adminApiToken.secretName=llm-gateway-token
```

The chart fails rendering at `helm install` time if neither
`database.bundled=true` nor `database.dsnSecretRef.name` is set.

## What gets installed

| Resource | Always | Bundled-only |
|---|---|---|
| `Deployment` (gateway, single replica) | yes | — |
| `Service` (ClusterIP, port 4000) | yes | — |
| `ServiceAccount` + `Role` + `RoleBinding` (read `ModelEndpoint`, patch `/status`) | yes | — |
| `Job` (Helm post-install/post-upgrade migrations) | when `migrations.enabled=true` | — |
| `Secret` (auto-generated DSN) | — | yes |
| Bitnami `postgresql` StatefulSet + PVC + Secrets | — | yes |

In-cluster consumers reach the gateway at:

```
http://<release>-llm-gateway.kagent-system.svc.cluster.local:4000
```

Common kagent path: the operator sets `LLM_GATEWAY_BASE_URL` on every
spawned agent-pod, pointed at the above Service URL.

## Upgrade

```bash
helm upgrade llm-gateway packages/llm-gateway/charts/llm-gateway/ \
  --namespace kagent-system \
  --reuse-values
```

The migration Job runs as a `post-upgrade` hook with
`hook-delete-policy=before-hook-creation,hook-succeeded`, so each upgrade
gets a fresh Job that idempotently applies pending schema migrations.

## Uninstall

```bash
helm uninstall llm-gateway --namespace kagent-system
```

When `database.bundled=true`, the Bitnami postgresql sub-chart's PVC is
**retained by default** (`bundled-postgres.primary.persistence.enabled=true`).
Delete the PVC manually if you want to drop the data:

```bash
kubectl delete pvc -n kagent-system -l app.kubernetes.io/name=postgresql
```

## Values

See `values.yaml` for the full surface and inline rationale. Key knobs:

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Set false to render zero resources (operator chart toggles this) |
| `image.repository` | `ghcr.io/ctkadvisors/kagent/llm-gateway` | |
| `image.tag` | `''` (defaults to `Chart.AppVersion`) | |
| `replicaCount` | `1` | Single replica only — in-flight counter is in-memory; HA needs Redis |
| `service.port` | `4000` | ClusterIP port |
| `database.bundled` | `false` | Opt-in in-cluster Postgres |
| `database.dsnSecretRef.name` | `''` | REQUIRED when `bundled=false` |
| `adminApiToken.secretName` | `''` | Bearer token for clients (chart fails install without one) |
| `migrations.enabled` | `true` | Helm post-install/post-upgrade Job |

## Bitnami postgresql dependency

The chart pins `bitnami/postgresql` to chart version `16.7.27` (Postgres
appVersion 17.6.0) via OCI:

```yaml
dependencies:
  - name: postgresql
    version: '16.7.27'
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: database.bundled
    alias: bundled-postgres
```

The dependency is conditional on `database.bundled` — when false, Helm
skips the sub-chart entirely (no resources, no values processing). When
bundled, the sub-chart's values land under `bundled-postgres.*` (see
`values.yaml`). Tarball is vendored under `charts/` after `helm dependency
update`, committed to the repo so installs are offline-clean.
