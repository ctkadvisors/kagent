# Same-task sandbox reattachment

Approved scope: preserve an existing live task sandbox when the gateway process
restarts. Discover Jobs through existing namespace-scoped list permissions;
validate namespace, task UID, agent, management labels, worker command and token
shape. Resolve only a Running pod controlled by the observed Job UID. Reuse its
original bearer token internally after an authenticated empty `readFiles` probe.
No credentials are logged or returned; RBAC and mounts remain unchanged.

Keep active Jobs during transient network/authentication/readiness failures;
poll under the existing ready timeout and return an unavailable error. Ignore
foreign identities. Delete only confirmed terminal owned Jobs with exact UID
preconditions. Stable new Job names and create-conflict recovery let concurrent
gateway instances share the same task workspace; legacy names remain reusable.

Report `workspace_recreated` before continuing when terminal state or a known
worker's disappearance proves that a replacement lost the old emptyDir. This
preserves same-task compute restart continuity, not durable storage: if both the
factory and old Job are gone there is no surviving loss marker. A new task UID
still receives a fresh isolated workspace, including independent verifiers.
Committed files remain necessary for terminal/new-task recovery.

Tests reproduce old two-factory data loss using actual worker file operations,
and cover byte fidelity, cross-task isolation, mismatched ownership/auth,
transient failures, terminal and known-missing loss, concurrent factories, and
Kubernetes pod/delete UID scoping. Root owns prepared in-stack restart acceptance;
this change does not authorize a rollout or artifact source modification.
