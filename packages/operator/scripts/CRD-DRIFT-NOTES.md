# CRD-drift checker — coverage notes

`check-crd-drift.ts` is a **pragmatic** drift check, not a full
bidirectional generator. It runs in CI as a separate job after typecheck
and exits non-zero if the YAML CRDs in `manifests/crds/` drift from the
TS types in `src/crds/types.ts` along the dimensions below.

## What we check today

| Dimension                                             | Where           | Coverage   |
| ----------------------------------------------------- | --------------- | ---------- |
| `spec.group` matches `API_GROUP` in types.ts          | each CRD YAML   | full       |
| `spec.versions[].name` includes `API_VERSION`         | each CRD YAML   | full       |
| `metadata.name` follows `<plural>.<group>` convention | each CRD YAML   | full       |
| `names.kind` / `names.plural` match expectation       | each CRD YAML   | full       |
| Required `spec` fields are present (model / payload / | Agent +         |            |
| capability)                                           | AgentTask +     |            |
|                                                       | AgentCapability | full       |
| All `spec` properties referenced by TS interfaces     | each CRD YAML   | full       |
| are listed in the YAML schema                         |                 |            |
| Status fields the operator/agent-pod read or write    | AgentTask only  | hand-coded |
| (phase, podName, structuralVerdict, artifacts, ...)   |                 | list       |

## What we do NOT yet check (acknowledged gap list)

The intent is to ship the bones today and deepen the check in later
phases. None of these are blockers for v0.1; pull from this list when
revisiting.

1. **Field-level type compatibility.** We only check whether the _key_
   exists in the YAML schema, not whether the YAML's `type:` (string /
   integer / array of string / etc.) matches the TS type's shape.
   Catching `string` vs `integer` mismatch would require parsing the
   schema tree, which today's regex-based reader can't do. Mid-term:
   swap to the `yaml` package + a real walker.

2. **Enum-value alignment.** When the TS type says
   `'default' | 'strict'` and the YAML's enum says `['default']`, we
   don't notice. Same fix path as (1).

3. **`required` arrays at nested levels.** We only check the top-level
   `spec.required:` list. CRD subschemas (e.g. `artifacts[].required:`)
   are not asserted against TS.

4. **Status-field types in TS interfaces vs YAML schema.** The TS types
   freely allow optional fields with rich union types; the YAML treats
   most of `status` as flat. A type-driven generator would emit a
   stricter YAML schema. Out of scope until v0.2 ships an actual
   generator (e.g. `ts-json-schema-generator` or a custom AST walker).

5. **`oneOf` / `anyOf` constraint round-trip.** The AgentTask YAML
   enforces "exactly one of `targetAgent` / `targetCapability`" via a
   `oneOf` block. The TS types make both fields optional but rely on
   reconcile.ts to enforce mutual exclusivity. We don't check that the
   `oneOf` block exists or that it lists the right keys.

6. **Bidirectional generation.** Today, both files are hand-edited.
   Eventually one should be the source of truth (probably TS) and the
   other generated. The cleanest path is a Cue-like tool or a
   ts-to-openapi converter.

7. **CRD readiness-after-install lint.** No check for `served: true` /
   `storage: true` flags or `subresources.status` presence on the
   CRDs the operator does status-writeback against.

## When to deepen the check

- Whenever a new optional spec field is added to a TS interface, the
  field name needs to be added to this script's `specProperties` list
  for the relevant CRD. The check will fail if the YAML omits it.

- When status-writeback adds a new field, append to that CRD's
  `statusProperties` list.

- When the **YAML** introduces a field the TS doesn't know about, this
  checker will pass silently. That's intentional — the YAML can be
  forward-compatible with v0.2 fields (e.g. extra status keys the
  operator hasn't started populating yet) without breaking the
  type-side check. Catching that direction needs the v0.2 generator.

## Why no `yaml` dep yet

Adding a YAML parser to the operator's dep graph just for CI is a poor
trade. The current regex reader is brittle but fast and doesn't extend
the production attack surface. Replacing it is a one-commit change once
the gap list above starts costing real bugs.
