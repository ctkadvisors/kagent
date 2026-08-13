# Self-Service Tools and Provider Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a default-off, self-hosted credential broker with a Workbench Tools/Connections UI and a GitHub App adapter that gives capability-bound agents structured GitHub tools plus native HTTPS clone, fetch, pull, and push.

**Architecture:** The operator resolves `Agent.spec.connectionRefs` and seals exact ProviderConnection UIDs into its existing task JWT. Agent pods forward that JWT to the tool gateway; the gateway and broker independently verify signed context, tools, and connections. Provider roots live as immutable Kubernetes Secrets in an isolated namespace, while native Git authenticates to a broker smart-HTTP proxy with the task JWT and never receives a GitHub installation token.

**Tech Stack:** TypeScript 5.9, Node 22, Hono, `jose`, `@kubernetes/client-node`, React 19/Vite, Vitest, Helm 3, Kubernetes CRDs/RBAC/NetworkPolicy, GitHub App REST and Git smart HTTP.

**Design:** `docs/superpowers/specs/2026-08-13-self-service-tools-connections-design.md`

---

## Execution topology

The implementation is split into six merge waves. A worker owns only the files named by its task.

1. **Wave A:** shared CRD/DTO/capability wire contract.
2. **Wave B:** gateway JWT enforcement and agent forwarding.
3. **Wave C:** broker core, Kubernetes store, GitHub adapter, and Git proxy.
4. **Wave D:** Workbench API/UI against the frozen broker contract.
5. **Wave E:** Helm, RBAC, NetworkPolicy, CI, and operations docs.
6. **Wave F:** cross-package tests, kind, homelab, and Qwen/new_localai proof.

Wave A lands first. After A, B and the broker scaffold from C may proceed concurrently. D may start
after Task 6 freezes broker DTOs. E may start after Tasks 4 and 6 freeze ports, ServiceAccounts,
and environment names. Wave F starts after all prior waves merge.

## File responsibility map

### Shared authority and resource contracts

- `packages/capability-types/src/types.ts` — signed task context and connection claim.
- `packages/capability-types/src/validate.ts` — strict wire validation.
- `packages/capability-types/src/subset.ts` — child connection narrowing.
- `packages/capability-types/src/jwt.ts` — JWT build/verify behavior and audiences.
- `packages/dto/src/provider-connections.ts` — safe provider/catalog/connection DTOs.
- `packages/operator/src/crds/provider-connection.ts` — runtime CR type guards.
- `packages/operator/manifests/crds/providerconnections.yaml` — authoritative CRD schema.

### Runtime authorization

- `packages/operator/src/cap-issuer.ts` — resolve and mint signed connection authority.
- `packages/operator/src/reconcile.ts` — task context and connection resolution.
- `packages/agent-pod/src/tool-gateway-provider.ts` — forward raw task JWT.
- `packages/tool-gateway/src/capability-verifier.ts` — gateway JWKS verifier.
- `packages/tool-gateway/src/http-server.ts` — enforce verified identity and authority.
- `packages/tool-gateway/src/broker-client.ts` — provider invocation client.

### Credential broker

- `packages/credential-broker/src/provider.ts` — adapter contract and registry.
- `packages/credential-broker/src/connection-store.ts` — exact CR/Secret persistence.
- `packages/credential-broker/src/capability-verifier.ts` — independent runtime verifier.
- `packages/credential-broker/src/admin-auth.ts` — Workbench projected-token validation.
- `packages/credential-broker/src/github/*` — GitHub App, tools, cache, and Git proxy.
- `packages/credential-broker/src/server.ts` — Hono admin/runtime/Git routes.

### Workbench

- `packages/workbench-api/src/broker-client.ts` — safe broker admin client.
- `packages/workbench-api/src/routes/tools.ts` — same-origin catalog/connection routes.
- `packages/workbench-ui/src/ToolsPage.tsx` — Tools/Connections page and wizard.
- `packages/workbench-ui/src/AppShell.tsx` and `App.tsx` — route/navigation wiring.

### Packaging and proof

- `packages/operator/charts/kagent-operator/templates/credential-broker-*.yaml` — broker bundle.
- `packages/operator/charts/kagent-workbench/templates/*` — Workbench broker access.
- `scripts/integration/provider-broker/*` — fake GitHub and real Git smart-HTTP proof.
- `docs/CREDENTIAL-BROKER.md` — installer/operator runbook.

---

### Task 1: Add signed task context and connection capability claims

**Files:**
- Modify: `packages/capability-types/src/types.ts`
- Modify: `packages/capability-types/src/validate.ts`
- Modify: `packages/capability-types/src/subset.ts`
- Modify: `packages/capability-types/src/jwt.ts`
- Modify: `packages/capability-types/src/index.ts`
- Test: `packages/capability-types/src/validate.test.ts`
- Test: `packages/capability-types/src/subset.test.ts`
- Test: `packages/capability-types/src/jwt.test.ts`

- [ ] **Step 1: Write failing validation and narrowing tests**

Add tests proving a valid bundle contains immutable task context, connection targets accept only
non-empty strings, and a child cannot add or widen a connection UID:

```ts
const context = {
  namespace: 'agents',
  taskName: 'build-1',
  taskUid: 'uid-1',
  agentName: 'builder',
  tenant: 'default',
} as const;

expect(validateCapabilityClaims({ connections: ['github:kagent-credentials/main@uid-c'] }).ok)
  .toBe(true);
expect(validateCapabilityClaims({ connections: [''] }).ok).toBe(false);
expect(
  claimsAreSubsetOf(
    { connections: ['github:kagent-credentials/main@uid-c'] },
    { connections: ['github:kagent-credentials/*'] },
  ),
).toBe(true);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm -F @kagent/capability-types test -- validate.test.ts subset.test.ts jwt.test.ts
```

Expected: failure because `context` and `connections` are not recognized or emitted.

- [ ] **Step 3: Implement the wire contract**

Add `CapabilityTaskContext`, `CapabilityClaims.connections`, and include `connections` in
`ALL_CAPABILITY_CLAIM_CATEGORIES`. Require `context` on newly minted bundles:

```ts
export interface CapabilityTaskContext {
  readonly namespace: string;
  readonly taskName: string;
  readonly taskUid: string;
  readonly agentName: string;
  readonly tenant?: string;
}

export interface CapabilityBundle {
  readonly iss: string;
  readonly sub: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly jti: string;
  readonly context: CapabilityTaskContext;
  readonly claims: CapabilityClaims;
}
```

Extend `BuildCapabilityJwtInput` with `context` and set it in the signed payload. Validate that
`context.taskUid` agrees with `sub` after JOSE verification. Use the existing glob subset dialect
for `connections` so exact UIDs and an operator-authored `*` ceiling compose with child narrowing.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
pnpm -F @kagent/capability-types test
pnpm -F @kagent/capability-types typecheck
```

Expected: all capability tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the authority schema**

```bash
git add packages/capability-types
git commit -m "feat(capabilities): bind task context and connections"
```

### Task 2: Add ProviderConnection CRD and safe shared DTOs

**Files:**
- Create: `packages/dto/src/provider-connections.ts`
- Modify: `packages/dto/src/index.ts`
- Create: `packages/dto/src/provider-connections.test.ts`
- Create: `packages/operator/src/crds/provider-connection.ts`
- Modify: `packages/operator/src/crds/index.ts`
- Create: `packages/operator/src/crds/provider-connection.test.ts`
- Create: `packages/operator/manifests/crds/providerconnections.yaml`
- Create: `packages/operator/charts/kagent-operator/crds/providerconnections.yaml`
- Modify: `packages/operator/scripts/check-crd-drift.ts`

- [ ] **Step 1: Write failing DTO and CR guards**

Define tests around these safe public shapes:

```ts
export interface ProviderConnectionSpec {
  readonly provider: string;
  readonly providerVersion: string;
  readonly enabled: boolean;
  readonly credentialRef?: { readonly name: string };
  readonly config: Readonly<Record<string, string | number | readonly number[]>>;
  readonly policy: {
    readonly repositories: readonly string[];
    readonly tools: readonly string[];
  };
}

export interface ConnectionSummary {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly phase: 'Pending' | 'Verifying' | 'Ready' | 'Degraded' | 'Error';
  readonly credentialConfigured: boolean;
  readonly credentialVersion?: string;
  readonly tools: readonly string[];
  readonly repositories: readonly string[];
  readonly lastValidatedAt?: string;
  readonly safeMessage?: string;
}
```

Tests must reject Secret values, unknown phase values, arbitrary credential refs in create DTOs,
and policy entries containing empty strings.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
pnpm -F @kagent/dto test -- provider-connections.test.ts
pnpm -F @kagent/operator test -- provider-connection.test.ts
```

Expected: failure because the modules do not exist.

- [ ] **Step 3: Implement DTOs, guards, and CRD schema**

The create/rotate request DTO accepts provider-specific credential fields as write-only input but
no response type contains them. The CRD must require `provider`, `providerVersion`, `enabled`,
`config`, and `policy`; status must use curated fields only. Add the CRD to the existing drift
check so chart and manifest copies must remain byte-equivalent.

- [ ] **Step 4: Run DTO/operator tests and CRD drift check**

```bash
pnpm -F @kagent/dto test
pnpm -F @kagent/operator test -- provider-connection.test.ts
pnpm -F @kagent/operator crd:check
```

Expected: all pass.

- [ ] **Step 5: Commit the resource contract**

```bash
git add packages/dto packages/operator/src/crds packages/operator/manifests/crds packages/operator/charts/kagent-operator/crds packages/operator/scripts/check-crd-drift.ts
git commit -m "feat(api): add provider connection contract"
```

### Task 3: Resolve Agent connection references into task capabilities

**Files:**
- Modify: `packages/operator/src/crds/types.ts`
- Modify: `packages/operator/manifests/crds/agent.yaml`
- Modify: `packages/operator/charts/kagent-operator/crds/agent.yaml`
- Modify: `packages/operator/src/cap-issuer.ts`
- Modify: `packages/operator/src/reconcile.ts`
- Test: `packages/operator/src/crds/agent.test.ts`
- Test: `packages/operator/src/cap-issuer.test.ts`
- Test: `packages/operator/src/reconcile.test.ts`

- [ ] **Step 1: Write failing admission and issuance tests**

Add an Agent fixture:

```ts
connectionRefs: [{ provider: 'github', name: 'github-main' }]
```

Inject a resolver that returns:

```ts
{
  provider: 'github',
  namespace: 'kagent-credentials',
  name: 'github-main',
  uid: 'connection-uid-1',
  enabled: true,
  ready: true,
}
```

Assert the minted bundle contains the signed task context and exactly
`github:kagent-credentials/github-main@connection-uid-1`. Assert missing, disabled, or unready
required connections keep the task Pending/Failed with a stable reason and do not create a Job.

- [ ] **Step 2: Run focused operator tests and verify failure**

```bash
pnpm -F @kagent/operator test -- agent.test.ts cap-issuer.test.ts reconcile.test.ts
```

Expected: connectionRefs are rejected or ignored and the JWT lacks context/connections.

- [ ] **Step 3: Implement connection resolution**

Add:

```ts
export interface AgentConnectionRef {
  readonly provider: string;
  readonly name: string;
}
```

Thread a `ProviderConnectionResolver` dependency into reconcile, use immutable CR UIDs when
building `claims.connections`, and pass task name/UID/namespace/agent/tenant into `CapIssuer`.
Preserve legacy Agents with no connectionRefs.

- [ ] **Step 4: Run tests, typecheck, and CRD drift**

```bash
pnpm -F @kagent/operator test -- agent.test.ts cap-issuer.test.ts reconcile.test.ts
pnpm -F @kagent/operator typecheck
pnpm -F @kagent/operator crd:check
```

Expected: all pass.

- [ ] **Step 5: Commit operator resolution**

```bash
git add packages/operator
git commit -m "feat(operator): seal provider connections into task caps"
```

### Task 4: Enforce capability JWTs at the tool gateway

**Files:**
- Create: `packages/tool-gateway/src/capability-verifier.ts`
- Create: `packages/tool-gateway/src/capability-verifier.test.ts`
- Modify: `packages/tool-gateway/src/http-server.ts`
- Modify: `packages/tool-gateway/src/server.ts`
- Modify: `packages/tool-gateway/src/index.ts`
- Modify: `packages/tool-gateway/package.json`
- Modify: `packages/agent-pod/src/tool-gateway-provider.ts`
- Modify: `packages/agent-pod/src/runner.ts`
- Test: `packages/tool-gateway/src/http-server.test.ts`
- Test: `packages/agent-pod/src/tool-gateway-provider.test.ts`

- [ ] **Step 1: Write the gateway authorization matrix**

Tests must cover missing, malformed, expired, wrong issuer, wrong audience, wrong task UID, wrong
namespace, wrong agent, wrong tenant, ungranted tool, ungranted connection, and profile expansion.
The success request uses:

```http
Authorization: Bearer <operator-signed JWT>
X-Kagent-Agent: builder
X-Kagent-Namespace: agents
X-Kagent-Task-Uid: uid-1
X-Kagent-Tenant: default
```

Assert invalid authentication returns 401, insufficient signed authority returns 403, and no
handler/provider is called.

- [ ] **Step 2: Run gateway/agent tests and verify failure**

```bash
pnpm -F @kagent/tool-gateway test -- capability-verifier.test.ts http-server.test.ts
pnpm -F @kagent/agent-pod test -- tool-gateway-provider.test.ts
```

Expected: requests currently succeed from self-asserted headers or omit Authorization.

- [ ] **Step 3: Implement verifier and forwarding**

Load JWKS from `KAGENT_CAP_JWKS_URL`, verify with `@kagent/capability-types`, and compare the
signed context to headers/body. Expose a test-injectable verifier:

```ts
export interface ToolCapabilityVerifier {
  verify(jwt: string): Promise<CapabilityBundle>;
}
```

Filter `/describe` output to names matching signed `claims.tools`. Add `capabilityJwt` to
`ToolGatewayProviderOptions`; runner supplies the already loaded raw JWT and the provider sends it
as bearer authentication.

- [ ] **Step 4: Run authorization tests and typechecks**

```bash
pnpm -F @kagent/tool-gateway test
pnpm -F @kagent/agent-pod test -- tool-gateway-provider.test.ts runner.test.ts
pnpm -F @kagent/tool-gateway typecheck
pnpm -F @kagent/agent-pod typecheck
```

Expected: all pass; no gateway route relies on headers as authority.

- [ ] **Step 5: Commit gateway enforcement**

```bash
git add packages/tool-gateway packages/agent-pod
git commit -m "feat(tool-gateway): enforce task capabilities"
```

### Task 5: Scaffold credential broker and trusted provider registry

**Files:**
- Create: `packages/credential-broker/package.json`
- Create: `packages/credential-broker/tsconfig.json`
- Create: `packages/credential-broker/vitest.config.ts`
- Create: `packages/credential-broker/Dockerfile`
- Create: `packages/credential-broker/src/provider.ts`
- Create: `packages/credential-broker/src/provider.test.ts`
- Create: `packages/credential-broker/src/config.ts`
- Create: `packages/credential-broker/src/config.test.ts`
- Create: `packages/credential-broker/src/index.ts`

- [ ] **Step 1: Write failing registry/config tests**

Define this adapter surface:

```ts
export interface ProviderAdapter {
  readonly manifest: ProviderManifest;
  validateCredential(input: unknown): Validation<Readonly<Record<string, string>>>;
  inspectConnection(input: InspectConnectionInput): Promise<ConnectionInspection>;
  describeTools(connection: SafeProviderConnection): readonly ToolDescriptor[];
  invoke(input: ProviderInvocation): Promise<ToolResult>;
  authorizeGit?(input: GitAuthorizationInput): Promise<GitUpstreamAuthorization>;
}
```

Assert duplicate provider IDs fail boot and config accepts only compiled provider IDs plus named
endpoint refs. Assert keys such as `command`, `package`, `image`, `headers`, and arbitrary `baseUrl`
are rejected.

- [ ] **Step 2: Run tests and verify module absence**

```bash
pnpm -F @kagent/credential-broker test
```

Expected: package/module not found.

- [ ] **Step 3: Implement the focused package scaffold**

Follow existing package scripts and Node 22 engine constraints. Register GitHub through a trusted
factory but use a fake adapter in registry tests. Export only safe types and construction
functions; do not export credential material types through DTO packages.

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm install --frozen-lockfile=false
pnpm -F @kagent/credential-broker test
pnpm -F @kagent/credential-broker typecheck
```

Expected: registry/config tests pass and lockfile includes the workspace package.

- [ ] **Step 5: Commit broker scaffold**

```bash
git add packages/credential-broker pnpm-lock.yaml
git commit -m "feat(broker): add trusted provider runtime"
```

### Task 6: Implement ProviderConnection and immutable Secret lifecycle

**Files:**
- Create: `packages/credential-broker/src/connection-store.ts`
- Create: `packages/credential-broker/src/connection-store.test.ts`
- Create: `packages/credential-broker/src/redact.ts`
- Create: `packages/credential-broker/src/redact.test.ts`
- Create: `packages/credential-broker/src/audit.ts`
- Create: `packages/credential-broker/src/audit.test.ts`
- Create: `packages/credential-broker/src/admin-api.ts`
- Create: `packages/credential-broker/src/admin-api.test.ts`

- [ ] **Step 1: Write failing create/rotate/delete/redaction tests**

Use an in-memory fake CoreV1/CustomObjects client. Assert create generates, rather than accepts, a
Secret name; Secret type is `kagent.knuteson.io/provider-credential`; `immutable` is true; and the
Secret is owner-referenced/labeled to the ProviderConnection. Seed `PEM-CANARY` and `ghs_CANARY`
and assert neither appears in response JSON, logs, status, or errors.

Audit tests assert connection create/rotate/test/disable/delete records actor, connection UID,
provider, action, time, and result class without request bodies, Secret data, private-key
fingerprints that can be reversed, provider tokens, or raw upstream errors.

Rotation tests must prove the old Secret remains referenced after failed provider validation and
is removed only after a successful atomic CR ref switch.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pnpm -F @kagent/credential-broker test -- connection-store.test.ts admin-api.test.ts redact.test.ts audit.test.ts
```

Expected: modules do not exist.

- [ ] **Step 3: Implement store and safe admin contract**

Expose:

```ts
export interface ConnectionStore {
  list(): Promise<readonly ConnectionSummary[]>;
  get(name: string): Promise<SafeProviderConnection | undefined>;
  create(input: CreateConnectionInput, actor: string): Promise<ConnectionSummary>;
  rotate(name: string, credential: unknown, actor: string): Promise<ConnectionSummary>;
  setEnabled(name: string, enabled: boolean, actor: string): Promise<ConnectionSummary>;
  delete(name: string, actor: string): Promise<void>;
  loadCredential(connection: SafeProviderConnection): Promise<Readonly<Record<string, string>>>;
}
```

Use optimistic resource versions for CR patches. Map raw Kubernetes/provider failures to stable
safe codes. Add `Cache-Control: no-store` to every credential-bearing mutation response. Publish
safe audit records through an injected sink; use a log sink by default and the existing optional
NATS audit publisher when configured.

- [ ] **Step 4: Run broker tests and typecheck**

```bash
pnpm -F @kagent/credential-broker test
pnpm -F @kagent/credential-broker typecheck
```

Expected: lifecycle/redaction tests pass.

- [ ] **Step 5: Commit broker persistence**

```bash
git add packages/credential-broker
git commit -m "feat(broker): manage immutable provider credentials"
```

### Task 7: Add broker runtime verification and server routes

**Files:**
- Create: `packages/credential-broker/src/capability-verifier.ts`
- Create: `packages/credential-broker/src/capability-verifier.test.ts`
- Create: `packages/credential-broker/src/admin-auth.ts`
- Create: `packages/credential-broker/src/admin-auth.test.ts`
- Create: `packages/credential-broker/src/server.ts`
- Create: `packages/credential-broker/src/server.test.ts`
- Create: `packages/credential-broker/src/main.ts`

- [ ] **Step 1: Write failing admin/runtime authorization tests**

Admin routes accept only a TokenReview-authenticated Workbench service token with audience
`kagent-credential-broker-admin`. Runtime and Git routes accept only operator capabilities with
audience `kagent-credential-broker`. Assert a Workbench token cannot invoke a provider and a task
capability cannot mutate connections.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm -F @kagent/credential-broker test -- capability-verifier.test.ts admin-auth.test.ts server.test.ts
```

Expected: missing modules/routes.

- [ ] **Step 3: Implement separate admin and runtime middleware**

Mount:

```text
GET/POST/PATCH/DELETE /v1/admin/connections...
GET                      /v1/admin/catalog
POST                     /v1/runtime/describe
POST                     /v1/runtime/invoke
GET                      /healthz
GET                      /readyz
```

Keep Git routes for Task 10. Readiness requires usable provider config, Kubernetes connectivity,
and a loaded capability JWKS. Do not cache a failed or unknown `kid` indefinitely.

- [ ] **Step 4: Run broker tests and typecheck**

```bash
pnpm -F @kagent/credential-broker test
pnpm -F @kagent/credential-broker typecheck
```

Expected: route/auth matrix passes.

- [ ] **Step 5: Commit broker boundaries**

```bash
git add packages/credential-broker
git commit -m "feat(broker): separate admin and task authority"
```

### Task 8: Implement GitHub App authentication and installation discovery

**Files:**
- Create: `packages/credential-broker/src/github/manifest.ts`
- Create: `packages/credential-broker/src/github/credentials.ts`
- Create: `packages/credential-broker/src/github/app-auth.ts`
- Create: `packages/credential-broker/src/github/app-auth.test.ts`
- Create: `packages/credential-broker/src/github/token-cache.ts`
- Create: `packages/credential-broker/src/github/token-cache.test.ts`
- Create: `packages/credential-broker/src/github/adapter.ts`
- Create: `packages/credential-broker/src/github/adapter.test.ts`

- [ ] **Step 1: Write failing GitHub auth/cache tests**

Use fake fetch responses for `GET /app`, paginated `GET /app/installations`, repository discovery,
and `POST /app/installations/:id/access_tokens`. Assert the App JWT uses RS256, `iat` includes safe
clock skew, `exp-iat <= 600`, and token requests contain one selected repository plus the minimum
permission subset.

Cache tests cover single-flight, a five-minute early-expiry window, 401 evict-and-retry-once,
rotation invalidation, disable invalidation, and no persisted `ghs_` token.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm -F @kagent/credential-broker test -- github/app-auth.test.ts github/token-cache.test.ts github/adapter.test.ts
```

Expected: GitHub modules do not exist.

- [ ] **Step 3: Implement GitHub manifest and App flows**

Credential schema requires `appId` and write-only `privateKeyPem`. Configuration selects fixed
`github-public`, installations, repositories, and tools. Reject arbitrary endpoints and redirects
away from `api.github.com`/`github.com`. Sanitize 401/403/404/409/422/429/5xx responses into the
design's stable errors.

- [ ] **Step 4: Run GitHub tests and broker typecheck**

```bash
pnpm -F @kagent/credential-broker test -- github
pnpm -F @kagent/credential-broker typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit GitHub authentication**

```bash
git add packages/credential-broker/src/github
git commit -m "feat(broker): authenticate GitHub Apps"
```

### Task 9: Add structured GitHub tools and broker client

**Files:**
- Create: `packages/credential-broker/src/github/tools.ts`
- Create: `packages/credential-broker/src/github/tools.test.ts`
- Create: `packages/tool-gateway/src/broker-client.ts`
- Create: `packages/tool-gateway/src/broker-client.test.ts`
- Modify: `packages/tool-gateway/src/http-server.ts`
- Modify: `packages/tool-gateway/src/server.ts`
- Modify: `packages/tool-gateway/src/tool-profiles.ts`
- Test: `packages/tool-gateway/src/http-server.test.ts`

- [ ] **Step 1: Write failing descriptor/invocation tests**

Cover the exact v1 catalog from the design. Assert descriptors disappear when installed GitHub
permissions are absent; inputs reject credentials, arbitrary headers/URLs, empty owner/repo, and
unknown fields. Assert `github.git.push` is tagged provider-write.

Gateway tests assert `github.*` is a valid profile tool family, forwarded calls preserve the task
JWT, and broker error bodies are scrubbed before becoming model-visible ToolResults.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pnpm -F @kagent/credential-broker test -- github/tools.test.ts
pnpm -F @kagent/tool-gateway test -- broker-client.test.ts http-server.test.ts
```

Expected: descriptors/client do not exist and profiles reject github names.

- [ ] **Step 3: Implement tools and delegation**

Implement repository metadata, contents read, issue list/create/comment, pull-request list/create,
and Git command descriptors. REST writes receive an idempotency/correlation ID but are not retried
automatically. The gateway delegates provider execution to `/v1/runtime/invoke`; it never receives
root credentials or installation tokens.

- [ ] **Step 4: Run broker/gateway tests and typechecks**

```bash
pnpm -F @kagent/credential-broker test
pnpm -F @kagent/tool-gateway test
pnpm -F @kagent/credential-broker typecheck
pnpm -F @kagent/tool-gateway typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit structured provider tools**

```bash
git add packages/credential-broker packages/tool-gateway
git commit -m "feat(tools): expose capability-bound GitHub tools"
```

### Task 10: Implement Git smart-HTTP proxy and task credential helper

**Files:**
- Create: `packages/credential-broker/src/github/git-proxy.ts`
- Create: `packages/credential-broker/src/github/git-proxy.test.ts`
- Modify: `packages/credential-broker/src/server.ts`
- Create: `packages/agent-pod/src/git-broker.ts`
- Create: `packages/agent-pod/src/git-broker.test.ts`
- Modify: `packages/agent-pod/src/main.ts`
- Modify: `packages/operator/src/job-spec.ts`
- Test: `packages/operator/src/job-spec.test.ts`

- [ ] **Step 1: Write failing Git protocol and pod-wiring tests**

Classify only:

```text
GET  .../info/refs?service=git-upload-pack   -> github.git.read
POST .../git-upload-pack                     -> github.git.read
GET  .../info/refs?service=git-receive-pack  -> github.git.write
POST .../git-receive-pack                    -> github.git.write
```

Reject other paths/services, traversal, malformed owner/repo/connection UID, cross-host redirects,
and write with a read-only capability. Assert the upstream Authorization header contains the
installation token while downstream responses/logs never do.

Job-spec tests assert broker-enabled Git agents receive only broker base URL and the already
mounted capability path; no GitHub env, Secret volume, or PAT is added.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pnpm -F @kagent/credential-broker test -- github/git-proxy.test.ts
pnpm -F @kagent/agent-pod test -- git-broker.test.ts
pnpm -F @kagent/operator test -- job-spec.test.ts
```

Expected: route/helper/config modules do not exist.

- [ ] **Step 3: Implement streaming proxy and helper configuration**

Proxy Git request/response bodies as streams, pin upstream to `https://github.com`, and inject
`x-access-token:<installation-token>` only in the upstream request. Configure native Git with a
credential helper scoped to the broker URL that returns username `kagent-task` and password equal
to the task JWT. Persist broker URLs without credentials; set `GIT_TERMINAL_PROMPT=0`.

- [ ] **Step 4: Run proxy/pod/operator tests and typechecks**

```bash
pnpm -F @kagent/credential-broker test -- github/git-proxy.test.ts
pnpm -F @kagent/agent-pod test -- git-broker.test.ts
pnpm -F @kagent/operator test -- job-spec.test.ts
pnpm -F @kagent/credential-broker typecheck
pnpm -F @kagent/agent-pod typecheck
pnpm -F @kagent/operator typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit native Git support**

```bash
git add packages/credential-broker packages/agent-pod packages/operator
git commit -m "feat(git): proxy task-scoped GitHub transport"
```

### Task 11: Add Workbench broker API facade

**Files:**
- Create: `packages/workbench-api/src/broker-client.ts`
- Create: `packages/workbench-api/src/broker-client.test.ts`
- Create: `packages/workbench-api/src/routes/tools.ts`
- Create: `packages/workbench-api/src/routes/tools.test.ts`
- Modify: `packages/workbench-api/src/router.ts`
- Modify: `packages/workbench-api/src/main.ts`
- Modify: `packages/workbench-api/src/error-scrub.ts`
- Test: `packages/workbench-api/src/error-scrub.test.ts`

- [ ] **Step 1: Write failing facade/redaction tests**

Cover every route in design section 10. Assert auth is required, the forwarded actor is preserved,
mutation responses have `Cache-Control: no-store`, request bodies are size-bounded, and
`privateKeyPem`, PEM blocks, App JWTs, `ghs_` tokens, and Kubernetes Secret data never appear in a
response or captured log.

- [ ] **Step 2: Run Workbench API tests and verify failure**

```bash
pnpm -F @kagent/workbench-api test -- broker-client.test.ts tools.test.ts error-scrub.test.ts
```

Expected: new routes/client absent.

- [ ] **Step 3: Implement same-origin safe routes**

Proxy catalog/list/create/test/rotate/enable/disable/delete to the broker admin API using the
projected Workbench service token. Return safe DTOs only; discard upstream bodies on unexpected
errors and map them to stable codes.

- [ ] **Step 4: Run API tests and typecheck**

```bash
pnpm -F @kagent/workbench-api test
pnpm -F @kagent/workbench-api typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit Workbench API**

```bash
git add packages/workbench-api
git commit -m "feat(workbench): add provider connection API"
```

### Task 12: Add Workbench Tools and Connections UI

**Files:**
- Create: `packages/workbench-ui/src/ToolsPage.tsx`
- Create: `packages/workbench-ui/src/ToolsPage.module.css`
- Create: `packages/workbench-ui/src/ToolsPage.test.tsx`
- Create: `packages/workbench-ui/src/ConnectionWizard.tsx`
- Create: `packages/workbench-ui/src/ConnectionWizard.test.tsx`
- Modify: `packages/workbench-ui/src/AppShell.tsx`
- Modify: `packages/workbench-ui/src/App.tsx`
- Modify: `packages/workbench-ui/src/api.ts`
- Modify: `packages/workbench-ui/src/types.ts`
- Test: `packages/workbench-ui/src/api.test.ts`

- [ ] **Step 1: Write failing navigation/page/wizard tests**

Assert `Tools` appears under Operate and routes to `#/tools`; local tabs switch between Tools and
Connections. Cover catalog ready/degraded/disabled states, empty connection state, schema-driven
GitHub fields, redacted review, creating/verifying/ready/error states, test, rotate, disable,
enable, and delete confirmation. Assert secret input values are cleared after submit and never
stored in URL or browser storage.

- [ ] **Step 2: Run UI tests and verify failure**

```bash
pnpm -F @kagent/workbench-ui test -- ToolsPage.test.tsx ConnectionWizard.test.tsx
```

Expected: components/routes do not exist.

- [ ] **Step 3: Implement the existing Workbench visual language**

Use the current left rail, table/card typography, state pills, spacing, and responsive patterns.
The Tools table shows name, source, risk, status, profiles, and eligible connections. The
Connections cards show safe connection metadata and actions. Provider forms render from catalog
field metadata; do not hardcode a GitHub-only page shell.

- [ ] **Step 4: Run UI tests, typecheck, and lint**

```bash
pnpm -F @kagent/workbench-ui test
pnpm -F @kagent/workbench-ui typecheck
pnpm -F @kagent/workbench-ui lint
```

Expected: all pass.

- [ ] **Step 5: Commit Workbench UI**

```bash
git add packages/workbench-ui
git commit -m "feat(workbench): add Tools and Connections UI"
```

### Task 13: Bundle broker, credentials namespace, RBAC, and NetworkPolicies

**Files:**
- Modify: `packages/operator/charts/kagent-operator/values.yaml`
- Modify: `packages/operator/charts/kagent-operator/templates/_helpers.tpl`
- Create: `packages/operator/charts/kagent-operator/templates/credential-broker-namespace.yaml`
- Create: `packages/operator/charts/kagent-operator/templates/credential-broker-deployment.yaml`
- Create: `packages/operator/charts/kagent-operator/templates/credential-broker-service.yaml`
- Create: `packages/operator/charts/kagent-operator/templates/credential-broker-rbac.yaml`
- Create: `packages/operator/charts/kagent-operator/templates/credential-broker-networkpolicy.yaml`
- Modify: `packages/operator/charts/kagent-operator/templates/tool-gateway-deployment.yaml`
- Modify: `packages/operator/charts/kagent-operator/templates/tool-runtime-rbac.yaml`
- Modify: `packages/operator/charts/kagent-operator/ci/kind-smoke-values.yaml`
- Create: `packages/operator/scripts/check-credential-broker-render.sh`

- [ ] **Step 1: Write a failing Helm render contract**

The script renders default values and asserts no broker resources. It then renders enabled values
and asserts: isolated retained namespace; broker SA; namespaced ProviderConnection/Secret RBAC;
only broker has provider Secret `get`; TokenReview permission is exact; projected Workbench token
audience; no provider Secret mounts in gateway/agent; ClusterIP Services; non-root/read-only
security contexts; probes; resources; and default-deny ingress/egress policies.

- [ ] **Step 2: Run render test and verify failure**

```bash
bash packages/operator/scripts/check-credential-broker-render.sh
```

Expected: failure because values/templates are missing.

- [ ] **Step 3: Implement default-off Helm bundle**

Add validated values for images, ports, credentials namespace, provider enablement, GitHub endpoint
ref, resources, node placement, and policies. Add a Helm fail condition: broker enabled requires
capabilities enabled, `allowMissing=false`, and toolRuntime enabled. Retain the credentials
namespace on uninstall and document explicit cleanup.

- [ ] **Step 4: Run Helm/CRD/operator checks**

```bash
bash packages/operator/scripts/check-credential-broker-render.sh
pnpm -F @kagent/operator crd:check
helm lint packages/operator/charts/kagent-operator
```

Expected: all pass.

- [ ] **Step 5: Commit operator packaging**

```bash
git add packages/operator/charts/kagent-operator packages/operator/scripts/check-credential-broker-render.sh
git commit -m "feat(chart): bundle credential broker"
```

### Task 14: Wire Workbench projected identity and broker networking

**Files:**
- Modify: `packages/operator/charts/kagent-workbench/values.yaml`
- Modify: `packages/operator/charts/kagent-workbench/templates/deployment.yaml`
- Modify: `packages/operator/charts/kagent-workbench/templates/networkpolicy.yaml`
- Modify: `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`
- Create: `packages/operator/scripts/check-workbench-tools-render.sh`

- [ ] **Step 1: Write failing Workbench render assertions**

Assert Tools enabled mounts a projected service-account token with audience
`kagent-credential-broker-admin`, configures broker URL/token path, allows egress only to broker,
and gives Workbench no Secret verbs. Existing forward-auth requirements remain unchanged.

- [ ] **Step 2: Run render test and verify failure**

```bash
bash packages/operator/scripts/check-workbench-tools-render.sh
```

Expected: failure because Tools broker values/templates are absent.

- [ ] **Step 3: Implement Workbench chart wiring**

Use explicit values `api.tools.enabled`, `api.tools.brokerUrl`, and a projected token path under
`/var/run/secrets/kagent-broker/token`. Keep the API route disabled/503 when configuration is
absent.

- [ ] **Step 4: Run chart tests**

```bash
bash packages/operator/scripts/check-workbench-tools-render.sh
helm lint packages/operator/charts/kagent-workbench
```

Expected: all pass.

- [ ] **Step 5: Commit Workbench packaging**

```bash
git add packages/operator/charts/kagent-workbench packages/operator/scripts/check-workbench-tools-render.sh
git commit -m "feat(workbench-chart): connect Tools to broker"
```

### Task 15: Add fake-GitHub and real Git integration proof

**Files:**
- Create: `scripts/integration/provider-broker/fake-github.ts`
- Create: `scripts/integration/provider-broker/git-roundtrip.test.ts`
- Create: `scripts/integration/provider-broker/credential-canary.test.ts`
- Modify: root `package.json`

- [ ] **Step 1: Write the failing end-to-end tests**

Start a fake GitHub App API and a temporary bare Git remote. Through real HTTP servers, create a
connection, validate it, mint a signed task capability, clone through the broker proxy, commit,
push, fetch, and pull. Then assert wrong task, repo, connection UID, expired token, and read-only
push are denied. Seed PEM/JWT/installation-token canaries and scan captured logs/results.

- [ ] **Step 2: Run integration tests and verify failure**

```bash
pnpm run test:credential-broker:integration
```

Expected: script is absent or integration fails before complete wiring.

- [ ] **Step 3: Complete only the integration harness and discovered contract fixes**

Keep fake-provider behavior faithful to GitHub's documented JWT, installation, repository, token,
and Git smart-HTTP endpoints. Contract fixes belong in the owning package with a regression test;
do not weaken the integration assertion.

- [ ] **Step 4: Run integration and full focused suites**

```bash
pnpm run test:credential-broker:integration
pnpm -F @kagent/capability-types test
pnpm -F @kagent/credential-broker test
pnpm -F @kagent/tool-gateway test
pnpm -F @kagent/agent-pod test
pnpm -F @kagent/workbench-api test
pnpm -F @kagent/workbench-ui test
pnpm -F @kagent/operator test
```

Expected: all pass.

- [ ] **Step 5: Commit integration proof**

```bash
git add scripts/integration/provider-broker package.json packages
git commit -m "test: prove brokered GitHub roundtrip"
```

### Task 16: Add CI, installer documentation, and delegation handoff

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/CREDENTIAL-BROKER.md`
- Modify: `docs/TOOL-BROKER.md`
- Modify: `docs/DROP-IN.md`
- Modify: `packages/operator/charts/kagent-operator/README.md`
- Modify: `packages/operator/charts/kagent-workbench/README.md`

- [ ] **Step 1: Add CI assertions and verify they initially fail**

CI must build/test the broker image/package, run both Helm render scripts, CRD drift, and the fake
GitHub integration. Run the same commands locally before editing workflow YAML and record the
expected job names in the workflow tests or documentation.

- [ ] **Step 2: Write the operator runbook**

Document: default-off values; GitHub GUI App creation; RS256 private-key download; Contents
read/write and optional Issues/PR permissions; Workbench connection wizard; installation/repo
selection; tool-profile and Agent connectionRefs examples; rotation/revocation; explicit retained
namespace cleanup; NetworkPolicy/FQDN limitation; audit/redaction; and Qwen native Git remote.

Use this exact no-secret Agent example:

```yaml
spec:
  toolProfileRef: github-builder
  connectionRefs:
    - provider: github
      name: github-main
  capabilityClaims:
    tools: [github.repository.get, github.git.read, github.git.write]
```

- [ ] **Step 3: Reconcile stale design docs**

Mark `docs/TOOL-BROKER.md` credential-to-ConfigMap flow superseded and link the implemented
credential broker. Do not rewrite unrelated historical sections.

- [ ] **Step 4: Run docs/CI-local checks**

```bash
pnpm exec prettier --check docs .github/workflows/ci.yml
bash packages/operator/scripts/check-credential-broker-render.sh
bash packages/operator/scripts/check-workbench-tools-render.sh
pnpm run test:credential-broker:integration
```

Expected: all pass.

- [ ] **Step 5: Commit docs and CI**

```bash
git add .github/workflows/ci.yml docs packages/operator/charts
git commit -m "docs: publish credential broker setup"
```

### Task 17: Run kind and homelab acceptance, then enable Qwen/new_localai

**Files:**
- Create: `evidence/credential-broker/kind-summary.md`
- Create: `evidence/credential-broker/homelab-summary.md`
- Modify only if required by deployment contract: sibling `new_localai` kagent values/configuration

- [ ] **Step 1: Run full repository verification under Node 22**

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
bash packages/operator/scripts/check-credential-broker-render.sh
bash packages/operator/scripts/check-workbench-tools-render.sh
pnpm run test:credential-broker:integration
```

Expected: every command exits 0.

- [ ] **Step 2: Run kind smoke with broker enabled**

Install CRDs/charts, create a fake connection through Workbench API, and execute the Git roundtrip
inside an operator-managed task pod. Capture rendered RBAC, NetworkPolicies, pod env/volumes,
connection status, and denial cases in `kind-summary.md`; include no Secret values.

- [ ] **Step 3: Deploy the reviewed images/charts to homelab**

Use the existing GitOps/image release path. Verify Workbench shows Tools and Connections before
entering the GitHub App key. Create `github-main` in the UI and select
`ctkadvisors/new_localai` with read/write Contents.

- [ ] **Step 4: Prove Qwen clone, pull, and push**

Run a bounded Qwen AgentTask against a disposable branch in `ctkadvisors/new_localai`. Prove HTTPS
clone, remote fetch/pull, a harmless commit, and push. Verify the pod has no SSH binary requirement,
PAT, GitHub App key, or installation token in env, mounted Secrets, argv, Git config, logs, traces,
or tool output.

- [ ] **Step 5: Record evidence and commit configuration/docs**

```bash
git add evidence/credential-broker docs packages
git commit -m "test: verify self-service GitHub tools"
```

Expected: evidence names image/chart versions, connection UID, task UID, branch, commit SHA, and
safe denial results without credential material.

---

## Final review gate

Before merging or declaring completion:

1. Compare every acceptance criterion in the design with Tasks 1-17 and the evidence pack.
2. Search repository diffs and captured outputs for `BEGIN .* PRIVATE KEY`, `ghs_`, App JWT
   canaries, Authorization headers, and Kubernetes Secret `data`.
3. Confirm Workbench has no Secret read verbs and provider credentials are outside
   `kagent-system`.
4. Confirm gateway and broker both reject forged headers without a valid operator JWT.
5. Confirm a child task cannot widen tools, connection UIDs, repositories, or write authority.
6. Confirm native Git push works without exposing a GitHub provider token.
7. Run the full Node 22 verification commands from Task 17 and preserve their current output.
