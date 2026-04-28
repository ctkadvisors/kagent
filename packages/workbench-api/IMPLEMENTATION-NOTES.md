# @kagent/workbench-api — Implementation Notes

**Status:** v0.1 — read-only HTTP facade. No mutating endpoints.
**Companion design doc:** [`../../docs/WORKBENCH.md`](../../docs/WORKBENCH.md).

This file captures decisions that aren't obvious from reading the code,
plus the explicitly-deferred work that the next slice picks up.

## Architecture in two paragraphs

The workbench-api is a thin read projection over Kubernetes. On boot it
opens cluster-wide informers on `AgentTask`, `Agent`, plus
`managed-by=kagent-operator` Job/Pod. Every event lands in an in-memory
`SnapshotCache` keyed by `<namespace>/<name>`. HTTP routes serve from
that cache through `@kagent/dto` mappers — there is zero K8s-projection
logic in the route layer, and no API-server roundtrips on the request
hot path.

Updates fan out to clients over Server-Sent Events. The UI subscribes
once, gets `{ kind, op, key }` notifications, and re-fetches the affected
list/detail endpoint. SSE was chosen over WebSockets because (a) the
Workbench is read-only, (b) SSE traverses Ingress without WebSocket-aware
config, and (c) browser EventSource gives us reconnect for free.

## Why @kagent/dto, not a dto-stub

The original blueprint called for a local `dto-stub.ts` to avoid coupling
the workbench-api to the operator. The published `@kagent/dto` package
landed before this slice, so we depend on it directly via
`"@kagent/dto": "workspace:*"`. The mappers (`taskSummary`,
`taskDetail`, `agentSummary`, `podFailureSummary`, `traceLink`) are
imported as-is. CRD type aliases (`Agent`, `AgentTask`,
`API_GROUP`/`API_VERSION`) are also re-exported by `@kagent/dto`, so the
operator package isn't needed as a dep at all.

## Auth (WS-A — header-trust gate)

The Workbench API is fail-closed by default. Every non-probe route
requires `X-Forwarded-User`; `/healthz` and `/readyz` are exempt so
kubelet probes keep working without an auth shim. The chart sets
`WORKBENCH_AUTH_REQUIRED=true` by default; only the literal string
`false` disables the gate for development.

The intended deployment path is header-trust behind the homelab's
existing Traefik + OAuth2 Proxy / Authelia chain. That upstream layer
terminates auth and passes identity headers to the API:

- `X-Forwarded-User` — username
- `X-Forwarded-Email` — email
- `X-Forwarded-Groups` — comma-separated group membership, reserved for
  future mutating endpoints

Out of band, the Ingress or Middleware chain must strip inbound
`X-Forwarded-*` headers before adding its own. Without that, a direct
client could spoof identity by sending the headers itself. Mutating
endpoints (cancel, retry — slated for v0.2) MUST be group-gated.
Admin-only remains the default posture.

## Cache invariants

- Keys are `<namespace>/<name>`; missing namespace defaults to
  `'default'` to match Kubernetes conventions.
- Delete events fire only when the key actually existed — this is what
  the SSE broker relies on to avoid spurious "row removed" notifications.
- Listener errors are swallowed by `SnapshotCache.emit`. The contract
  is "best-effort fan-out"; a single misbehaving SSE subscriber must
  not poison the loop. The SseBroker counts dropped events
  per-subscription so a panel can surface "X events dropped" later.

## Job/Pod ↔ Task join

The Workbench joins by the `kagent.knuteson.io/task` label that the
operator already applies. This is O(n) per join because we don't
secondary-index in v0.1 — n stays small (cluster-wide AgentTask count
on the homelab is dozens, not thousands). When this becomes an issue
we'd add a `Map<taskKey, jobKey>` reverse index inside `SnapshotCache`.

## SSE backpressure

Each subscriber's writes are fire-and-forget. If a write throws (closed
socket, full buffer), the broker counts it and bumps a per-subscription
counter. Sub-side throttling could be added later — for v0.1 the
volume is low enough that "drop and let the UI re-fetch on the next
event" is correct.

## Stream stability + heartbeat

The /api/stream route emits a `heartbeat` event every 25 seconds. This
keeps idle proxies (Traefik default idle timeout: 90s) from killing
the connection mid-flight. The UI watches `lastEventAt` and flips a
status chip to "stale" if no event arrives for 60s — works as a coarse
"is the server still talking to me" signal.

## What isn't in this slice (per WORKBENCH.md §7)

These were intentionally cut from v0.1:

- POST/PUT/DELETE — no cancel, no retry, no task creation (read-only
  first, write actions only after the read views prove useful)
- Chat / prompt playground — out of scope; would conflict with the
  "platform, not channel" stance in PLATFORM-PRIORITIES.md §1
- YAML editor — would tempt operators into editing in the UI instead
  of GitOps
- Live pod log/exec — adds a streaming path with auth implications
  separate from the read-only model
- Custom trace database — Langfuse owns that surface; we link out
- Multi-tenant auth — header-trust today, RBAC v0.2

## Operational env knobs

- `WORKBENCH_PORT` (default 8080) — HTTP listen port
- `WORKBENCH_HOSTNAME` (default 0.0.0.0)
- `WORKBENCH_AUTH_REQUIRED` (default true) — require
  `X-Forwarded-User` on every non-probe route; only `false` disables it
- `KAGENT_NO_INFORMER` — skip informer boot. Used by CI to verify the
  entrypoint resolves without contacting a cluster

`WORKBENCH_*` (no `KAGENT_` prefix) is the chart contract — see
`packages/operator/charts/kagent-workbench/templates/deployment.yaml`.
`KAGENT_NO_INFORMER` keeps the prefix because it's a kagent-internal
test knob, not a chart-managed runtime input.

## Verifying the entrypoint

The brief asks for a brief no-cluster smoke test. The standard recipe:

```bash
KAGENT_NO_INFORMER=1 WORKBENCH_AUTH_REQUIRED=false WORKBENCH_PORT=18999 \
  pnpm --filter @kagent/workbench-api start &
sleep 2
curl -sS http://127.0.0.1:18999/healthz                # → {"status":"ok"}
curl -sS http://127.0.0.1:18999/readyz                 # → {"status":"ok",...}
curl -sS http://127.0.0.1:18999/api/tasks              # → {"items":[]}
curl -sS http://127.0.0.1:18999/api/agents             # → {"items":[]}
kill %1
```

When informers are wired (no `KAGENT_NO_INFORMER`), the same routes
return populated arrays sourced from the live cluster.
