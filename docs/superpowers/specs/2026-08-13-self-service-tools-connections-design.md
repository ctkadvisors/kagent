# Self-Service Tools and Provider Connections Design

**Date:** 2026-08-13  
**Status:** Approved for planning and implementation  
**License:** MIT

## 1. Outcome

Bundle a self-hosted credential broker with kagent and add a first-class **Tools** area to
Workbench. Any authenticated Workbench user can create, rotate, test, disable, and delete
provider connections. Agents receive provider-backed tools through their existing task
capability, never a long-lived provider credential.

GitHub Apps are the first provider. The first release must support:

- GitHub App setup through GitHub's own GUI;
- self-service connection setup in Workbench;
- short-lived GitHub installation tokens;
- structured GitHub tools;
- native Git clone, fetch, pull, and push from agent containers; and
- a provider adapter contract that later supports Jira and other services without changing
  the agent/tool-gateway contract.

The stack remains portable: enabling the broker and its trusted provider adapters is Helm
configuration. Provider code ships in pinned kagent images; configuration cannot upload or
execute arbitrary plugin code.

## 2. Decisions

The following decisions are locked for this slice:

1. A dedicated `kagent-credential-broker` Deployment owns provider authentication and token
   lifecycle.
2. Provider credentials are stored as Kubernetes Secrets in an isolated credentials namespace.
3. Workbench is fully self-service. Every authenticated Workbench user may administer every
   connection. There is no second admin/group gate.
4. Workbench never reads a stored credential back. Secret fields are write-only.
5. GitHub uses a GitHub App, not a deploy key or PAT.
6. The tool gateway and broker independently verify the operator-minted task capability JWT.
7. Native Git uses an internal smart-HTTP proxy authenticated by the task capability. The
   GitHub installation token remains inside the broker.
8. Provider adapters are trusted, compiled modules registered in the broker image. Helm config
   enables and configures adapters; it cannot supply executable code.
9. Existing chart-defined tool profiles remain the v1 source of truth. Dynamic profile editing
   and a `ToolProfile` CRD are follow-ups, not prerequisites for connection management.
10. This design supersedes the credential-resolution portions of `docs/TOOL-BROKER.md` that
    place resolved provider configuration in an agent-mounted ConfigMap.

## 3. Why a dedicated broker

### 3.1 Selected: central credential broker

The broker has one purpose: turn a signed kagent task authority plus a named connection into the
minimum provider operation or short-lived provider token needed for that operation. It is the
only runtime workload allowed to read provider Secrets.

This keeps the tool gateway focused on tool/session dispatch and prevents provider root
credentials from entering agent pods, gateway environment variables, tool descriptors, model
context, or traces.

### 3.2 Rejected: provider adapters inside tool-gateway

This is fewer pods, but it gives the gateway access to every provider Secret and combines
credential lifecycle, Kubernetes Secret access, provider networking, tool dispatch, and sandbox
control in one compromise boundary.

### 3.3 Rejected: credential sidecar in every agent pod

This improves per-task isolation but multiplies Secret mounts and lifecycle state. It also makes
every agent image and pod template depend on provider plumbing. The native-Git proxy supplies
the required Git compatibility without mounting provider credentials into a sidecar.

## 4. Architecture

```text
Browser
  |
  | TLS + authenticated Workbench session
  v
Workbench UI -> Workbench API -> credential-broker admin API
                                      |
                                      +-> ProviderConnection CR
                                      +-> immutable versioned Secret
                                      +-> GitHub App validation

Agent pod -- task capability JWT --> tool-gateway -- same JWT --> credential-broker
    |                                    |                         |
    | structured tools                   | policy/profile          +-> GitHub REST API
    |                                    | enforcement             +-> installation-token mint
    |                                    |
    +-- native git + task JWT -----------+-------------------------> Git smart-HTTP proxy
                                                                      |
                                                                      +-> github.com Git HTTP
                                                                          with installation token
```

The operator remains the authority root. It resolves an Agent's declared connection references
when dispatching an AgentTask and seals the exact connection UIDs and tool names into the task
capability. A connection name alone is never authority.

## 5. Components

### 5.1 `@kagent/credential-broker`

A new Node 22 workspace package and container image. It owns:

- provider manifests and trusted adapter registration;
- connection create, validate, rotate, disable, and delete operations;
- `ProviderConnection` reconciliation and status;
- exact Secret reads and immutable Secret rotation;
- task-capability verification;
- provider policy checks;
- short-lived token minting and bounded caching;
- structured provider invocation;
- the Git smart-HTTP proxy;
- response/error redaction; and
- non-secret audit records.

It does not own agent selection, LLM prompting, tool-profile expansion, Kubernetes Jobs, or
general-purpose HTTP proxying.

### 5.2 Tool gateway

The existing tool gateway remains the agent-facing structured-tool endpoint. It gains:

- mandatory bearer capability authentication for `/describe` and `/invoke` when capability
  enforcement is enabled;
- signature/issuer/audience/expiry validation through the operator JWKS;
- signed task-context comparison;
- tool-profile intersection with `claims.tools`;
- connection-authority intersection with `claims.connections`;
- a broker client for `provider.*` and `github.*` tools; and
- provider/catalog health projections for Workbench.

Self-asserted `X-Kagent-*` headers remain useful correlation fields but cease to be authority.

### 5.3 Agent pod

The agent pod already receives an operator-signed JWT at `/var/kagent/cap/cap.jwt`. Its gateway
provider forwards the raw token as `Authorization: Bearer ...`. It still verifies the capability
locally for its built-in tools; gateway and broker verification are independent enforcement
points.

For native Git, the operator configures a credential helper for the broker's internal Git URL.
The helper returns the task JWT, which the agent already possesses, not a GitHub token. Native Git
therefore works without SSH and without a provider credential in the image.

### 5.4 Workbench

Workbench adds `#/tools` to the left rail. The page has two local tabs:

- **Tools** — provider/builtin tool catalog, readiness, risk, active profiles, connection health,
  and recent safe usage metadata.
- **Connections** — provider connection cards plus add, test, rotate, disable, enable, and delete
  actions.

Every request still requires the existing forward-auth identity. The actor is recorded for audit,
but all authenticated actors have the same connection administration authority by design.

## 6. Kubernetes resource model

### 6.1 Credentials namespace

The operator chart creates or targets a dedicated namespace, default `kagent-credentials`:

```yaml
credentialBroker:
  enabled: false
  credentialsNamespace: kagent-credentials
  createCredentialsNamespace: true
```

ProviderConnection resources and their Secrets live together in this namespace so owner
references and garbage collection work. This namespace must contain no operator signing keys,
model credentials, Langfuse credentials, or unrelated application Secrets.

The namespace is retained by default on Helm uninstall. Removal of stored provider credentials
must be an explicit operator action.

### 6.2 `ProviderConnection` CRD

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: ProviderConnection
metadata:
  name: github-main
  namespace: kagent-credentials
spec:
  provider: github
  providerVersion: v1
  enabled: true
  credentialRef:
    name: github-main-cred-01J...
  config:
    endpointRef: github-public
    installations: [1234567]
  policy:
    repositories:
      - ctkadvisors/new_localai
      - ctkadvisors/kagent
    tools:
      - github.repository.*
      - github.git.read
      - github.git.write
status:
  observedGeneration: 1
  observedCredentialVersion: 01J...
  phase: Ready
  principal:
    displayName: ctkadvisors-kagent
    providerId: "987654"
  installationCount: 1
  repositoryCount: 2
  lastValidatedAt: "2026-08-13T12:00:00Z"
  conditions: []
```

Rules:

- `credentialRef` is generated by the broker. The browser cannot select an arbitrary Secret.
- Status contains no provider token, private-key material, Secret data, or raw provider error.
- Policy is a ceiling. A task capability and tool profile can narrow it but cannot widen it.
- Capability authority binds `metadata.uid`, not only the reusable connection name.
- `enabled: false` is immediate logical revocation.
- A finalizer removes versioned credential Secrets before connection deletion completes.

### 6.3 Agent reference

Add an optional connection declaration to `Agent.spec`:

```yaml
spec:
  toolProfileRef: github-builder
  connectionRefs:
    - provider: github
      name: github-main
```

The operator resolves each name in the configured credentials namespace during task admission.
Missing, disabled, or unready connections fail admission for an Agent that requires them. The
resolved identity sealed into the task capability is:

```text
github:kagent-credentials/github-main@<provider-connection-uid>
```

Connection references narrow on child-task spawn like all other capability categories.

### 6.4 Immutable Secret versions

Secrets use type `kagent.knuteson.io/provider-credential`, `immutable: true`, and labels for
provider, connection UID, and credential version. Credential values exist only in `Secret.data`.

Rotation is:

1. Validate new input syntactically in memory.
2. Create a new immutable Secret with a generated version.
3. Validate it against the provider.
4. Atomically patch `ProviderConnection.spec.credentialRef`.
5. Reconcile status to the new version.
6. Delete the old Secret after the successful switch.

A failed validation deletes the staged Secret and leaves the previous credential active. No
operation writes credential data into the CR, an event, an annotation, or a log.

## 7. Capability contract

Extend the signed capability bundle with immutable task context and a connection claim:

```ts
interface CapabilityBundle {
  // existing iss/sub/aud/exp/iat/nbf/jti/claims
  readonly context: {
    readonly namespace: string;
    readonly taskName: string;
    readonly taskUid: string;
    readonly agentName: string;
    readonly tenant?: string;
  };
}

interface CapabilityClaims {
  // existing categories
  readonly connections?: readonly string[];
}
```

The operator adds the `kagent-tool-gateway` audience for gateway-using tasks and
`kagent-credential-broker` when a connection-backed tool or Git remote is authorized.

Before `/describe` or `/invoke`, the gateway verifies:

1. bearer token is present;
2. JOSE algorithm, signature, `kid`, issuer, audience, expiry, and schema;
3. `sub === task-uid:<context.taskUid>`;
4. signed namespace/task UID/agent/tenant match the request and correlation headers;
5. requested tool matches `claims.tools`;
6. profile expansion is intersected with `claims.tools`; and
7. the selected connection UID matches `claims.connections`.

The broker repeats checks 1-7. A compromised gateway therefore cannot name another connection or
tool merely by changing a downstream body.

Missing or invalid authentication returns 401. A valid capability lacking authority returns 403
with `policy_denied`. Neither case reaches a provider.

When the broker is enabled, Helm requires capabilities to be enabled, missing capabilities to be
fail-closed, and a JWKS URL to be configured. A cold broker or gateway that cannot load a usable
JWKS is not ready.

## 8. Provider adapter contract

Adapters are trusted modules compiled into the broker image:

```ts
interface ProviderAdapter {
  readonly manifest: ProviderManifest;
  validateCredential(input: unknown): Validation<NormalizedCredential>;
  inspectConnection(input: InspectConnectionInput): Promise<ConnectionInspection>;
  describeTools(connection: SafeConnection): readonly ToolDescriptor[];
  invoke(input: ProviderInvocation): Promise<ToolResult>;
  authorizeGit?(input: GitAuthorizationInput): Promise<GitUpstreamAuthorization>;
}
```

`ProviderManifest` supplies:

- stable provider id and adapter version;
- display name and icon key;
- safe endpoint references;
- credential-field schema with secret/write-only flags;
- connection configuration schema;
- tool descriptors, risk tags, and required provider permissions; and
- supported capabilities such as `structuredTools`, `gitProxy`, or `oauthCallback`.

Helm configuration enables trusted adapters:

```yaml
credentialBroker:
  enabled: true
  providers:
    github:
      enabled: true
      endpoint: github-public
    jira:
      enabled: false
```

Config cannot specify a command, npm package, container image, arbitrary JavaScript, arbitrary
headers, or an unrestricted base URL. A new provider implementation is a reviewed package change
and broker image release.

## 9. GitHub App adapter

### 9.1 GitHub-side setup

The operator creates a GitHub App in GitHub's GUI and installs it only on approved organizations,
users, and repositories. The minimum baseline permissions are:

- Metadata: read (GitHub-required repository metadata);
- Contents: read and write for clone/pull/push; and
- optional Pull requests and Issues read/write only when those structured tools are desired.

No webhook, client secret, OAuth callback, or user authorization is required for the v1
organization-owned machine identity flow.

### 9.2 Workbench wizard

The GitHub connection wizard is:

1. **Choose provider** — GitHub.
2. **App credentials** — connection name, GitHub App ID, and private-key PEM.
3. **Validate app** — broker signs a short-lived App JWT and reads App identity/installations.
4. **Choose installations** — select one or more discovered installations.
5. **Repository scope** — choose repositories within the installation's existing scope.
6. **Tools** — choose a subset supported by the App's installed permissions.
7. **Review and save** — show names/scopes only, never the private key.

After submission, secret inputs are cleared and never repopulated. The UI displays only a
credential fingerprint/version, validation time, App identity, installation/repository counts,
and status.

### 9.3 Token minting

For each operation the broker:

1. loads the exact current Secret referenced by the UID-bound connection;
2. signs an RS256 GitHub App JWT with a lifetime of at most ten minutes;
3. identifies the installation owning the requested repository;
4. requests an installation token limited to the selected repositories and required permission
   subset;
5. performs the provider operation or injects the token into the upstream Git request; and
6. discards or caches the token only within the bounded cache below.

Installation tokens may be cached for at most 50 minutes, keyed by connection UID, credential
version, installation ID, repository set, and permission set. Disable, deletion, or credential
rotation invalidates matching cache entries immediately. The token is never returned in a tool
result.

### 9.4 Structured GitHub tools

The initial catalog is deliberately small:

| Tool | Risk | Purpose |
|---|---|---|
| `github.repository.get` | read | Repository metadata and permissions |
| `github.contents.read` | read | Read a repository file at a ref |
| `github.issues.list` | read | List repository issues |
| `github.issues.create` | write | Create an issue |
| `github.issues.comment` | write | Comment on an issue |
| `github.pull_requests.list` | read | List pull requests |
| `github.pull_requests.create` | write | Create a pull request |
| `github.git.clone` | write-workspace/read-provider | Clone into the task workspace |
| `github.git.fetch` | write-workspace/read-provider | Fetch remote refs |
| `github.git.pull` | write-workspace/read-provider | Pull into the task workspace |
| `github.git.push` | provider-write | Push allowed refs |

The adapter may omit descriptors whose provider permissions are unavailable. Tool arguments never
accept a credential, arbitrary header, or arbitrary provider URL.

### 9.5 Native Git smart-HTTP proxy

Native Git cannot use a structured REST tool for its packet protocol. The broker therefore
provides a narrow proxy:

```text
http://<broker-service>/git/<connection-uid>/<owner>/<repo>.git/...
```

Agent Git authenticates to this internal endpoint with its task JWT. The broker maps protocol
operations to capability names:

- `git-upload-pack` and read-only `info/refs` require `github.git.read`;
- `git-receive-pack` requires `github.git.write`.

The broker also requires the exact UID-bound connection claim and repository policy, then proxies
only the Git smart-HTTP paths to the fixed GitHub upstream while injecting the installation token.
It rejects cross-host redirects and arbitrary upstream paths.

The agent can inspect its own task JWT; that is already true today. It cannot retrieve the GitHub
App key or installation token. Compromise is bounded by the task JWT's expiry, exact connection,
repository ceiling, and read/write tool claims.

This proxy is the path used to repair Qwen/new_localai checkout: the image needs `git` and HTTPS,
not SSH or a PAT. Its remote points at the broker proxy, so clone, pull, and push use the same
task-scoped authority.

## 10. Workbench API and UX

### 10.1 Routes

Workbench API exposes a same-origin, redacting facade:

```text
GET    /api/tools/catalog
GET    /api/tools/connections
POST   /api/tools/connections
GET    /api/tools/connections/:name
POST   /api/tools/connections/:name/test
POST   /api/tools/connections/:name/rotate
PATCH  /api/tools/connections/:name          # enabled/policy only
DELETE /api/tools/connections/:name
GET    /api/tools/usage
```

Secret-bearing create/rotate bodies are bounded in size, never logged, never echoed, and are sent
to the broker over its cluster-only admin API. Workbench has no Secret read permission. Broker
responses use safe DTOs shared with the UI.

### 10.2 Tools tab

The Tools tab shows:

- tool name and description;
- provider/builtin source;
- read/write/destructive risk tag;
- active/unavailable/disabled status;
- reason when unavailable, such as missing connection or provider permission;
- profiles that contain the tool;
- eligible connection count; and
- safe recent invocation count/failure rate.

It is a catalog and health surface in v1. Profile source remains Helm/GitOps configuration.

### 10.3 Connections tab

Connection cards show provider, display name, state, principal/App identity, installations,
repository count, permitted tool families, credential version/fingerprint, last validation,
last use, and last safe error.

Actions are add, test, rotate, enable/disable, and delete. Rotate never requires or displays the
old value. Delete requires an ordinary destructive confirmation but no approval workflow.

## 11. RBAC and network policy

### 11.1 Broker RBAC

In the credentials namespace only:

- `providerconnections`: get/list/watch/create/patch/update/delete;
- `providerconnections/status`: get/patch/update;
- provider credential Secrets: get/create/delete; and
- no access to Pods, exec, Jobs, unrelated namespaces, or cluster Secrets.

The broker creates generated immutable Secret names. It does not accept arbitrary Secret refs from
the browser. Secret list/watch is avoided; invocation performs an exact `get` for the referenced
name.

### 11.2 Workbench RBAC

Workbench receives no provider-Secret verbs. It calls the broker admin API using a projected,
short-lived service-account token with a broker-specific audience. It may read safe
ProviderConnection resources for projection, or use broker list responses.

The broker validates this administrative service identity with Kubernetes TokenReview and an
exact audience. Its only cluster-scoped permission is `tokenreviews:create`; that permission does
not grant access to Secrets or other workload resources. Runtime provider and Git proxy requests
use operator task capabilities instead of this administrative identity.

### 11.3 Operator RBAC

The operator may get/list/watch ProviderConnections to resolve Agent connection refs at admission.
It has no provider Secret access.

### 11.4 Tool-gateway RBAC

The gateway has no provider Secret access. Existing SandboxClaim RBAC remains independently gated.

### 11.5 Network policy

Broker ingress permits:

- admin API from Workbench API pods;
- structured invocation from tool-gateway pods; and
- Git proxy traffic from operator-managed agent pods.

Broker egress permits DNS, Kubernetes API, operator JWKS, optional NATS audit, and provider HTTPS.
Application policy pins GitHub hosts and rejects private/link-local destinations and cross-host
redirects. Vanilla NetworkPolicy cannot safely express GitHub's changing FQDN addresses; installs
with Cilium or an egress proxy should additionally enforce FQDN policy.

Gateway ingress permits operator-managed agent pods. Gateway egress is limited to broker,
configured browser/code backends, operator JWKS, DNS, optional audit, and Kubernetes API only when
the SandboxClaim backend requires it.

## 12. Error handling and audit

Provider failures map to stable sanitized codes:

- `connection_not_found`
- `connection_disabled`
- `connection_not_ready`
- `credential_invalid`
- `installation_not_found`
- `repository_not_allowed`
- `provider_permission_missing`
- `provider_rate_limited`
- `provider_unavailable`
- `policy_denied`

Read-only calls may retry bounded 429/5xx responses using provider retry metadata. Write calls are
not automatically replayed unless an idempotency key makes the operation provably safe. Git stream
failures close the stream and let Git report the transport failure.

Audit records contain actor or task UID, capability JTI, connection UID/name, provider, tool or Git
operation, repository, latency, result class, and safe rate-limit metadata. They never contain the
private key, App JWT, installation token, Authorization header, Secret body, cookie, or raw provider
response headers.

All provider errors and model-visible results pass through exact in-memory token redaction plus
generic credential-pattern scrubbing before leaving the broker.

## 13. Testing strategy

### 13.1 Unit tests

- capability schema, signing, verification, connection subset narrowing, and signed-context match;
- gateway missing/invalid/expired/wrong-task/wrong-tool/wrong-connection rejection;
- profile expansion cannot widen signed tools;
- immutable Secret create/rotation/cleanup and redacted DTOs;
- GitHub App JWT and installation-token request formation using fake HTTP;
- repository/permission policy intersection;
- installation token cache keys, expiry, rotation invalidation, and disable invalidation;
- Git smart-HTTP route classification and upstream host pinning;
- broker error/result redaction;
- Workbench request parsing, size limits, safe responses, and every mutation action;
- Tools/Connections rendering and wizard state transitions; and
- Helm render assertions for RBAC, namespaces, Services, projected tokens, and NetworkPolicies.

### 13.2 Integration tests

Run a fake GitHub server plus a real temporary bare Git repository through the broker proxy:

1. create a connection through the Workbench API;
2. observe Ready without retrieving secret material;
3. mint a task capability;
4. clone through the Git proxy;
5. commit and push;
6. fetch/pull the pushed commit;
7. prove a different repo, connection UID, task UID, or read-only capability is denied;
8. rotate the App key and prove the new version is used;
9. disable the connection and prove immediate denial; and
10. scan logs/results/events for seeded credential canaries.

### 13.3 Cluster/UAT

In kind and the homelab:

- install the chart with GitHub enabled and no preexisting provider Secret;
- create the GitHub connection entirely through Workbench;
- verify the browser never receives stored secret values;
- run a Qwen AgentTask against `ctkadvisors/new_localai`;
- prove native HTTPS clone, pull, and push;
- prove the task pod has no GitHub App key or installation token in env, volumes, process args, or
  tool output;
- prove expired and forged capability tokens fail closed; and
- verify cleanup leaves no orphan credential versions or unbounded token cache.

## 14. Rollout and compatibility

The entire broker is default-off. Existing installations and static external providers continue to
work unchanged when disabled.

Implementation order:

1. Harden capability transport and gateway verification.
2. Add ProviderConnection API and broker core with fake provider.
3. Add GitHub App REST adapter and Secret lifecycle.
4. Add Git smart-HTTP proxy and native Git helper wiring.
5. Add Workbench Tools/Connections APIs and UI.
6. Add Helm bundle, RBAC, NetworkPolicies, image build, and documentation.
7. Run fake-provider integration, kind, then homelab GitHub UAT.
8. Point the Qwen/new_localai workflow at the broker Git URL.

Static `externalProvidersJson` and existing chart `toolProfiles` remain supported. Provider-backed
tools must never silently fall back to static headers or ambient environment credentials.

## 15. Delegation map

This feature is intentionally partitioned so Claude, Qwen, or other contributors can work from this
document without redefining authority boundaries.

### Work package A — capability and gateway enforcement

Owns `capability-types`, operator issuance/admission, agent JWT forwarding, gateway verification,
and policy tests. Must land before provider invocation is enabled.

### Work package B — ProviderConnection and broker core

Owns the CRD, safe DTOs, broker server, Kubernetes store, Secret rotation, plugin registry,
redaction, status reconciliation, and fake-provider tests. Depends on A's verifier contract, not on
the GitHub adapter.

### Work package C — GitHub adapter and Git proxy

Owns GitHub credential validation, App/installation token flows, provider policy, structured tools,
smart-HTTP proxy, native Git helper contract, and fake-GitHub integration tests. Depends on B.

### Work package D — Workbench API and UI

Owns the Tools route, catalog and connection DTO facade, wizard, actions, safe errors, and UI tests.
Can start against B's fake broker contract after its DTO/API interface is frozen.

### Work package E — Helm and operations

Owns broker/credentials namespace templates, RBAC, projected service identity, NetworkPolicies,
values/schema/docs, image workflow, render tests, and kind smoke. Depends on the ports, env, and SA
audiences frozen by A/B.

### Work package F — integration and homelab UAT

Owns cross-package integration, credential-canary scans, chart install, GitHub App setup runbook,
Qwen/new_localai clone/pull/push proof, and evidence capture. Starts only after A-E merge.

Each package must stay within its ownership boundary. Shared DTO or CRD changes are coordinated
through B; capability wire changes through A; chart contract changes through E.

## 16. Acceptance criteria

- Workbench has a `Tools` navigation item with Tools and Connections views.
- Any authenticated Workbench user can fully manage provider connections.
- GitHub App credentials can be entered and rotated without YAML or `kubectl`.
- Stored credential values are never readable through Workbench or broker APIs.
- Provider Secrets are isolated from kagent-system credentials.
- Gateway and broker reject calls not authorized by a valid operator task JWT.
- Profile expansion cannot widen the signed tool set.
- Connection authority is bound to the ProviderConnection UID and narrows on child spawn.
- GitHub installation tokens are repository/permission scoped, short-lived, and never returned to
  an agent or model.
- Native Git clone, fetch, pull, and push work using the internal broker proxy.
- The Qwen runner can operate on `ctkadvisors/new_localai` without SSH or a PAT.
- GitHub is a normal adapter behind a provider-neutral broker contract.
- Helm users can enable the same stack and GitHub adapter through declarative values.
- Unit, integration, Helm render, kind, and homelab UAT evidence pass.

## 17. Non-goals

- Hosted Arcade, Nango, Composio, or another external credential control plane.
- User-delegated GitHub OAuth identities in v1.
- Jira implementation in the first slice; Jira is the second-adapter contract proof.
- Runtime-loaded npm modules, arbitrary MCP executables, arbitrary HTTP headers, or arbitrary
  provider URLs as “plugins.”
- Per-user Workbench roles, ownership, or approval workflows.
- A general secrets manager or replacement for Kubernetes Secret encryption/KMS.
- Returning raw provider tokens to agents.
- Dynamic ToolProfile authoring in Workbench v1.
