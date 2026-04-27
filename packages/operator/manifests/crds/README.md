<!-- SPDX-License-Identifier: MIT -->

# CRD source of truth

These YAML files are the **source of truth** for the kagent v1alpha1
CRDs. Three artifacts have to stay in sync:

1. `packages/operator/manifests/crds/*.yaml` — this directory.
   Authoritative.
2. `packages/operator/charts/kagent-operator/crds/*.yaml` — Helm copy
   that ships with the operator chart. Required to be a byte-for-byte
   copy of (1).
3. `packages/operator/src/crds/types.ts` — TypeScript projections used
   by the operator + DTO mappers. Required to mirror the schema in (1).

When you change a CRD:

```bash
# 1. Edit the static manifest under packages/operator/manifests/crds/
$EDITOR packages/operator/manifests/crds/agenttask.yaml

# 2. Mirror into the Helm chart copy.
cp packages/operator/manifests/crds/*.yaml \
   packages/operator/charts/kagent-operator/crds/

# 3. Update src/crds/types.ts if the schema change is observable from
#    the operator's TypeScript surface (most schema changes are).

# 4. Verify the two copies are byte-identical:
diff -r packages/operator/manifests/crds/ \
        packages/operator/charts/kagent-operator/crds/
```

A drift-guard CI step is on the v0.2 follow-up list (deferred only
because the workflow file lives behind a security-review hook that
flags any `run:` block on the `.github/workflows/` path). Until that
lands, the chart README and this file are the only enforcers — keep
them honest.

## History

The artifact-writer slice (P3 wire-up; commits `2a7f89c` →
`a2bc443` → `e1533e8`) added `status.artifacts[]` to the chart copy of
`agenttask.yaml` but skipped the static manifest. Resyncing happened on
2026-04-27. The same risk applies to every future schema change until
the CI guard is wired.
