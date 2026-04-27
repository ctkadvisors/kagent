<!-- SPDX-License-Identifier: MIT -->

# Workbench image build path

The `kagent-workbench-api` and `kagent-workbench-ui` images are produced by two
parallel CI pipelines:

- **GitHub Actions** ([`.github/workflows/images.yml`](../../.github/workflows/images.yml))
  builds + pushes `ghcr.io/ctkadvisors/kagent-workbench-{api,ui}` on every push
  to `main`, on tags matching `v*-phase*` or `vX.Y.Z`, and on manual
  `workflow_dispatch`. Per-image `cache-from/cache-to` scopes keep cold builds
  bounded.
- **Gitea Actions** ([`.gitea/workflows/build.yaml`](../../.gitea/workflows/build.yaml))
  pushes the same images to the homelab registry at
  `git.knuteson.io/homelab/kagent-workbench-{api,ui}` for ArgoCD to sync.

Both workflows use repo root as the build context so the workbench packages can
pull `@kagent/dto` (and any other workspace dep) via pnpm.

## Manual workaround for Gitea mirror not triggering Actions

Per [`docs/ROADMAP.md`](../../docs/ROADMAP.md) Phase 4.x, Gitea 1.22.3's
mirror-pull from GitHub does NOT fire its own Actions workflows. Until the
homelab Gitea/Forgejo upgrade lands, after pushing the tag to GitHub:

1. Wait for the mirror sync (or click **Synchronize Now** in the Gitea UI).
2. In the homelab Gitea UI for `homelab/kagent`, open Actions →
   "BuildKit Container Build" → **Run workflow** against the new tag.

Alternative: run `docker buildx build --push -f packages/workbench-{api,ui}/Dockerfile .`
from a workstation against `git.knuteson.io/homelab/`.

## Recommended initial tag

`v0.0.5-workbench-mvp` — push it manually after the workbench packages and the
Helm chart at `packages/operator/charts/kagent-workbench/` have all landed and
been reviewed. Both pipelines react to that tag pattern automatically.
