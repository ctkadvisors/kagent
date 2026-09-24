# Fleet advisory AgentTask contract

These Agent resources are the kagent side of the independent fleet B2 slice.
`researcher.json` is the only allowed target for the protected authority's
candidate-question dispatcher. It may delegate to `source-checker.json` once;
the child cannot delegate. Both use `reasoner-default`, currently mapped to
Spark `ornith15` in the production kagent overlay, and cap model access to that
physical ID. They grant Graphiti reads, in-cluster SearXNG search, and local
Steel browser reads; no memory write, shell, repository, GitHub, lab, or release
tool is granted.

`@kagent/operator` exports `buildAdvisoryTask`, `dispatchAdvisoryQuestion`,
`kubernetesAdvisoryTaskStore`, and `readAdvisoryResult`. The caller submits a
bounded candidate question with source and evidence IDs. The adapter pins the
namespace and target Agent, hashes the exact payload, recovers exact replays,
and returns only UID-fenced `unverified` hypotheses and a bounded plan. A
completed AgentTask is never a lab or release verdict.

These resources are source manifests, not an active GitOps overlay. Promotion
requires a `new_localai` change that installs them through homelab CI and Argo,
grants the protected dispatcher only namespaced AgentTask create/get, and
enforces its task identity and exact repository allowlist at the API boundary.
Kubernetes RBAC alone cannot restrict `create` by target Agent; admission or a
protected service boundary must enforce that restriction. Network policy must
allow only the named local search, memory, browser, and Spark paths. Keep B2
disabled until P0 hostile-test isolation and A's lab denial probes pass.
