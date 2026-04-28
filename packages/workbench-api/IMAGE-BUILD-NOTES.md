<!-- SPDX-License-Identifier: MIT -->

# Workbench image build path

The `kagent-workbench-api` and `kagent-workbench-ui` images are produced by
the `build-images` matrix in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and published
to:

- `ghcr.io/ctkadvisors/kagent-workbench-api`
- `ghcr.io/ctkadvisors/kagent-workbench-ui`

Triggers: every tag matching `v*` (any version-prefixed tag —
pre-release, MVP, or final) and manual `workflow_dispatch`. PR and
main-branch pushes run the verify gate only; they do not push images.
The metadata-action emits image tags from `type=ref,event=tag`, which
preserves the leading `v`, so a git tag `v0.0.5-workbench-mvp` produces
an image tag `v0.0.5-workbench-mvp` that lines up exactly with
`Chart.appVersion`. Per-image `cache-from/cache-to` scopes keep cold
builds bounded. Build context is the repo root so the workbench packages
can pull `@kagent/dto` (and any other workspace dep) via pnpm.

## History — why there's no Gitea pipeline

Pre-public-release, this repo also shipped `.gitea/workflows/build.yaml`
mirroring the same images to `git.knuteson.io/homelab/kagent-workbench-*`
so the homelab cluster could pull from an in-cluster registry without
external creds. Once the GitHub repo went public, ghcr.io packages from
public repos became public-and-unauthenticated, so the homelab cluster
can pull straight from ghcr.io with no pull secret. The Gitea workflow
was deleted; chart defaults point at ghcr.io.

The chart still pulls its **git source** from the in-cluster Gitea mirror
(ArgoCD's `repoURL` in `new_localai/k8s/argocd-apps/kagent-*-app.yaml`)
because the mirror is read-only and that path has no external dependency
risk. Only image pulls were moved.

## Recommended initial tag

`v0.0.5-workbench-mvp` — pushed against `main` after the workbench
packages, Helm chart, and Dockerfiles have all landed. The GitHub
Actions workflow reacts to that tag pattern automatically; check the
Actions tab on github.com/ctkadvisors/kagent for build status.

## Auth (WS-A — security baseline)

The workbench-api is FAIL-CLOSED by default. The chart sets
`api.authRequired: true` (see
`packages/operator/charts/kagent-workbench/values.yaml`); that renders
into the container as `WORKBENCH_AUTH_REQUIRED=true`, and the API
rejects every non-probe request that doesn't carry the
`X-Forwarded-User` header (set upstream by Traefik forward-auth or
oauth2-proxy).

`/healthz` and `/readyz` are exempt — kubelet probes still work without
an auth shim in front of the pod.

To disable enforcement (dev-only): `--set api.authRequired=false`. The
container logs a loud warning at boot in that mode.
