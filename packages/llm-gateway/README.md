# @kagent/llm-gateway

OpenAI-compatible HTTP gateway that fronts multiple LLM backends
(Ollama, LocalAI, Cloudflare AI Gateway, OpenAI, Anthropic, Bedrock,
Groq, Exo, mock) with **per-(model, backend) AIMD-tuned in-flight
admission control**, observability hooks, and a BYO Postgres for API
keys + usage attribution.

This is the `kagent`-substrate gateway. It replaces the deferred
LiteLLM Proxy slot — see
[`docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md`](../../docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md)
for the full design and decision log.

## Status

Wave 1A (this package) is the standalone TypeScript implementation.
Wave 1B owns the `ModelEndpoint` CRD + RBAC, Wave 1C owns the Helm
sub-chart + bundled Postgres switch. Operator-side admission
control (Wave 2) is the primary queue; gateway 429s are last-resort
safety per spec §3.2.

## Endpoints

| Method | Path                       | Auth                | Purpose                                     |
| ------ | -------------------------- | ------------------- | ------------------------------------------- |
| POST   | `/v1/chat/completions`     | bearer (api_keys)   | OpenAI-compat completions (non-streaming)   |
| GET    | `/v1/models`               | none                | Models registered via ModelEndpoint CRs     |
| GET    | `/admin/capacity`          | bearer (admin tok)  | Live in-flight + AIMD-tuned cap per row     |
| GET    | `/admin/usage[?filters]`   | bearer (admin tok)  | usage_records query (taskUid, agentName, …) |
| GET    | `/healthz`                 | none                | Liveness                                    |
| GET    | `/readyz`                  | none                | Readiness (200 only when pg pings clean)    |

## Environment

| Var                          | Required | Default             | Purpose                                   |
| ---------------------------- | -------- | ------------------- | ----------------------------------------- |
| `DATABASE_URL`               | yes      | —                   | libpq DSN. Gateway never owns the DB; the chart wires this from a Secret per §3.7. |
| `ADMIN_API_TOKEN`            | yes      | —                   | Bearer for `/admin/*`.                     |
| `PORT`                       | no       | `4000`              | http listen port.                          |
| `BACKEND_TIMEOUT_MS`         | no       | `60000`             | Per-backend dispatch timeout (currently a hint; provider impls own timeout). |
| `MODEL_ENDPOINT_NAMESPACE`   | no       | `kagent-system`     | K8s namespace the informer watches for `ModelEndpoint` CRs. |

## Design highlights

- **AIMD self-tuning** (`src/aimd.ts`). Cap rises by 1 per
  60-second clean window (no errors, no latency spikes); halves on
  a 429/error or a 2x rolling-p50 latency spike. Bounds come from
  `ModelEndpoint.spec.inFlight.{seed,max}` and `spec.minSafe`.
- **In-memory in-flight counter** (`src/inflight-counter.ts`).
  Single-replica v1 (HA via Redis or leader-election is deferred).
- **Provider factory exhaustive on `BackendKind`** — adding a new
  backend immediately surfaces as a TS compile error in
  `src/providers/provider-factory.ts`.
- **BYO Postgres** — `DATABASE_URL` only. The bundled Postgres
  StatefulSet is Wave 1C's chart concern; this package is agnostic.
- **Migrations** are forward-only and idempotent — boot runs them,
  the chart's post-install Job also runs them, both no-op if
  already applied (`schema_migrations` table).

## Local development

```sh
# Use Node 22.22 (the engines pin)
source ~/.nvm/nvm.sh && nvm use 22.22.0

# Install workspace deps from the repo root
pnpm install

# Run tests
pnpm --filter @kagent/llm-gateway test

# Typecheck
pnpm --filter @kagent/llm-gateway typecheck

# Build (emits dist/)
pnpm --filter @kagent/llm-gateway build

# Run against a local Postgres + a single ModelEndpoint
DATABASE_URL=postgres://kagent:kagent@localhost:5432/kagent \
ADMIN_API_TOKEN=dev-token \
PORT=4000 \
pnpm --filter @kagent/llm-gateway start
```

`/admin/capacity` is your first stop after boot — it shows the
ModelEndpoint cache the K8s informer has populated and the
AIMD-current cap per (model, endpoint).

## Backends

| Backend kind | Provider impl                              | Auth?          |
| ------------ | ------------------------------------------ | -------------- |
| `mock`       | canned responses; no network               | no             |
| `ollama`     | Ollama `/api/chat` (NDJSON streaming)      | no             |
| `localai`    | OpenAI-compat                              | no             |
| `openai`     | OpenAI public API                          | yes (`sk-...`) |
| `anthropic`  | `/v1/messages` with `x-api-key`            | yes            |
| `groq`       | OpenAI-compat                              | yes            |
| `exo`        | OpenAI-compat                              | no             |
| `cloudflare` | AI Gateway workers-ai route, OpenAI-compat | yes            |
| `bedrock`    | stub (throws); enable in v0.2              | yes            |

The agent-pod stamps `X-Kagent-Task-UID` and `X-Kagent-Agent` on
every request; absent headers are valid (logged with NULL columns)
so non-kagent consumers can use the same gateway.

## License

MIT — © 2026 Chris Knuteson. See repo root `LICENSE`.
