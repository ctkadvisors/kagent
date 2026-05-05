# Gateway Conformance Evidence Runbook

**Scope:** Enterprise Pilot RC evidence for an external model gateway implementing [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md).

The harness is CI-friendly: unit tests use mocked `fetch`, so no live gateway or secrets are required in PR validation. The same code can be pointed at a staging gateway to produce a JSON evidence artifact.

## CI Mocked Probe

```sh
pnpm --filter @kagent/llm-gateway test -- src/conformance.test.ts
```

This verifies:

- `traceparent` is syntactically W3C Trace Context and sent on the chat probe.
- `X-Kagent-Task-UID`, `X-Kagent-Agent`, and `X-Kagent-Tenant` are sent.
- `429` / `503` responses are only conformant when `Retry-After` is present as seconds.
- `POST /v1/admin/keys/rotate` sends admin bearer auth, accepts `2xx`, and records `404` as unsupported fallback.
- mTLS/SVID expectations have an available path: SVID-backed mTLS or bearer fallback.

## Live RC Evidence

Run from the repo root against a staging gateway and redirect stdout to an evidence file:

```sh
KAGENT_GATEWAY_URL='https://gateway.example.com' \
KAGENT_GATEWAY_MODEL='gpt-4o' \
KAGENT_GATEWAY_API_TOKEN='sk-...' \
KAGENT_GATEWAY_ADMIN_TOKEN='...' \
KAGENT_GATEWAY_MTLS_ENABLED='false' \
KAGENT_GATEWAY_SVID_AVAILABLE='false' \
KAGENT_GATEWAY_BEARER_FALLBACK='true' \
pnpm --filter @kagent/llm-gateway conformance:live \
  > gateway-conformance.enterprise-pilot.json
```

Optional attribution overrides:

```sh
KAGENT_GATEWAY_TASK_UID='agenttask-uid-from-staging'
KAGENT_GATEWAY_AGENT='pilot-agent'
KAGENT_GATEWAY_TENANT='pilot-tenant'
KAGENT_GATEWAY_TRACEPARENT='00-<trace-id>-<span-id>-01'
```

The CLI exits non-zero when any check has status `fail`. A `warn` is still evidence but should be handled before RC signoff when it affects an Enterprise Pilot requirement, especially `rotation.endpoint` returning `404`.

## Evidence Review

Required pass criteria for Enterprise Pilot RC:

| Check | RC expectation |
| --- | --- |
| `chat.required_headers` | `pass` |
| `chat.openai_response` | `pass`, unless the run intentionally forced backpressure |
| `chat.backpressure_retry_after` | `pass` when the run forced `429` / `503`; `skip` is acceptable only when backpressure was not exercised |
| `rotation.endpoint` | `pass`; `warn` means gateway fallback works but endpoint support is missing |
| `identity.mtls_svid_fallback` | `pass` |

For backpressure evidence, use a staging key or tenant quota that reliably returns `429` or a controlled unhealthy-upstream scenario that returns `503`. Do not attempt to infer `Retry-After` compliance from a normal `2xx` chat run.

## Secret Handling

The JSON report records status, selected response headers, and check outcomes. It does not include the API token, admin token, chat request body, or chat response body. Keep shell history and CI logs out of secret-bearing command invocations; prefer ephemeral staging tokens.
