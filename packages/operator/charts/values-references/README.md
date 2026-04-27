# Helm chart references for upstream dependencies

The `kagent-operator` chart only deploys the operator + CRDs. The supporting infrastructure (NATS JetStream, LiteLLM, Langfuse) lives in upstream Helm charts you install separately. The files in this directory are **opinionated `values.yaml` overrides** for each — the bare minimum to make the upstream chart play nicely with kagent's conventions.

These are not reusable subcharts; they're documentation. The actual deployment to the homelab K3s cluster is owned by the sibling repo [`new_localai`](https://github.com/ctkadvisors/new_localai), where ArgoCD applies them via `Application` manifests pointing at the upstream chart + the `values.yaml` from this directory (or an inline override).

## Layout

```
values-references/
├── README.md                 ← this file
├── nats-jetstream.yaml       ← values for nats-io/nats Helm chart
├── litellm.yaml              ← values for berriai/litellm Helm chart
└── langfuse.yaml             ← values for langfuse/langfuse Helm chart
```

## Install order (cluster bootstrap)

When standing up a fresh cluster:

1. **NATS JetStream** — operator's dispatcher publishes here. Operator + agent pods both need to reach the NATS Service.
2. **LiteLLM** — agent pods call this for inference. The default `KAGENT_LITELLM_BASE_URL` in agent-pod/src/env.ts assumes the Service is at `litellm.kagent-system.svc.cluster.local:4000/v1`.
3. **Langfuse** — agent pods point `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` at Langfuse's OTLP endpoint. Optional; if unset, the operator + agent pods both no-op the OTel sink and only log to stdout.
4. **kagent-operator** (this chart) — applied last so the CRDs and operator boot pointed at the already-running NATS / LiteLLM / Langfuse.

## Why kagent's chart doesn't bundle these as subcharts

- **Tenant scoping**: in production these are often shared infra (one Langfuse instance for many apps); bundling forces single-tenant ownership.
- **Upgrade independence**: the operator iterates fast; NATS / Langfuse upgrade on their own cadence.
- **Homelab vs cloud**: on the homelab, these run in a `kagent-system` namespace with local-path PVCs; on cloud, they're managed (Aiven NATS, hosted Langfuse). Same operator chart, different infra.
