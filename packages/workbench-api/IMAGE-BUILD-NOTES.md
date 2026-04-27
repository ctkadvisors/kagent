<!-- SPDX-License-Identifier: MIT -->

# Workbench image build path

The `kagent-workbench-api` and `kagent-workbench-ui` images are produced by
[`.github/workflows/images.yml`](../../.github/workflows/images.yml) and
published to:

- `ghcr.io/ctkadvisors/kagent-workbench-api`
- `ghcr.io/ctkadvisors/kagent-workbench-ui`

Triggers: every push to `main`, tags matching `v*-phase*` or `vX.Y.Z`, and
manual `workflow_dispatch`. Per-image `cache-from/cache-to` scopes keep cold
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
