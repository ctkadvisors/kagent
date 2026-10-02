# Task diagnostics

`GET /api/tasks/:namespace/:name/diagnostics?afterSequence=-1&limit=20`
returns the retained execution evidence for that AgentTask. `limit` accepts
1–100 events. Read the next page with `afterSequence=trace.nextSequence` while
`trace.hasMore` is true. The server derives the trace ID from the task UID or
its inherited traceparent, and filters observations to that exact run ID.
Parent and sibling task content is excluded.

The response identifies the task, configured run bounds, children, artifact
references, and current pod conditions/container states. Its `trace.events`
contain the ordered model/tool operations, tool arguments, offered input
schema, results, errors, usage and terminal status. An `operation_started`
event is an independent ended span exported before provider dispatch; pair
its `operationId` with the subsequent completion. A remaining start identifies
an interrupted or still-running operation. Completed tool output includes its
stdout/stderr when the tool returns those fields.

Tool arguments, schemas, results and errors are redacted before capture and
bounded to 65,536 characters each. Oversize records carry an explicit
truncation marker. This diagnostic payload is retained with Langfuse tool
observations even under the ordinary prompt preview policy; content mode
`none` still omits bodies. The API also masks legacy records on read.
Credentials and auth headers remain server-side.

The deployed self-hosted Langfuse v3 serves `/api/public/traces/{traceId}`.
Configure the Workbench chart with `api.langfuseApi.url` and
`api.langfuseApi.credentialSecretRef.{name,publicKeyKey,secretKeyKey}`. These
map to `WORKBENCH_LANGFUSE_API_URL`, `WORKBENCH_LANGFUSE_PUBLIC_KEY` and
`WORKBENCH_LANGFUSE_SECRET_KEY`. The API distinguishes `observed`, `pending`
(ingestion not visible yet), and `unavailable` (missing reader, upstream failure,
or response above 8 MiB). Upstream response bodies and request headers are
never returned in errors. Langfuse v4 needs an observations-v2 adapter before
upgrading this reader.

Current pod logs are bounded to 200 lines/65,536 bytes per container, including
the previous container instance after a restart. After Job/Pod garbage
collection, `pod.state` is `gone`; retained tool arguments, results and operation
markers remain readable from Langfuse. This endpoint does not archive raw
Kubernetes stdout. Exporting markers is bounded and best-effort during a
Langfuse outage, so telemetry failure does not block provider dispatch.
