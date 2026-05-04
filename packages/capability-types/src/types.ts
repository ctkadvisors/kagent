/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability bundle JWT schema — the substrate's sealed authority token
 * primitive (per docs/SUBSTRATE-V1.md §3.6).
 *
 * A capability JWT names every right an AgentTask has: which tools it
 * may invoke, which models it may call, which artifacts to read, which
 * Agents to spawn, which workspaces to mount, which egress domains to
 * reach. The operator's capability-issuer mints + signs; admission
 * validates; agent-pod surfaces relevant claims via `get_my_context`.
 *
 * **Composition rule (substrate-enforced, non-negotiable):** spawn
 * produces a child capability ⊆ parent's. The substrate validates this
 * at admission. *No application code can re-grant.*
 *
 * **Why the central elegance bet:** capabilities collapse three
 * currently-separate concerns — `allowedChildAgents`, RBAC, secret
 * hygiene — into one primitive. The audit question "can children spawn
 * arbitrary agents?" has a single substrate answer: only if
 * `cap.claims.spawn` includes the target name.
 *
 * Wire format: a JOSE-format JWS, alg `ES256` (recommended) or `RS256`.
 * The signing key is provisioned per `cap-ca.ts` in the operator —
 * either Helm-mounted from a K8s Secret (file-mount path) or
 * cert-manager-rotated (Issuer path). Both paths are supported.
 *
 * **API stability:** this package is the SHARED INTERFACE the rest of
 * Wave 2 (Supervision + Workflows) imports. Schema additions are
 * SemVer-minor; renaming a claim is a SemVer-major bump. Keep the
 * surface stable.
 */

/**
 * The 9 substrate-recognized claim categories. Each is an array of
 * GLOB patterns (see `glob-match.ts`); a request matches a category
 * iff one of the listed patterns matches its target.
 *
 * Empty / undefined for a category = NONE allowed (fail-closed). The
 * substrate NEVER admits a category default-true.
 *
 * Order in this interface mirrors the spec example in
 * docs/SUBSTRATE-V1.md §3.6 — kept stable for grep/diff legibility.
 */
export interface CapabilityClaims {
  /**
   * Tool names the agent loop is allowed to invoke. Examples:
   * `'http_get'`, `'spawn_child_task'`, `'write_artifact'`,
   * `'read_artifact'`. Patterns may be globs (`'wait_*'` admits all
   * `wait_for_*` family tools).
   */
  readonly tools?: readonly string[];

  /**
   * Model identifiers (provider-prefixed, per
   * GATEWAY-CONTRACT.md §2.1). Examples: `'workers-ai/@cf/meta/...'`,
   * `'openai/gpt-4o'`. Patterns may be globs
   * (`'workers-ai/@cf/meta/llama-*'`). Empty = no models.
   */
  readonly models?: readonly string[];

  /**
   * Agent names this task may spawn as children via
   * `spawn_child_task`. Patterns may be globs (`'summarizer-*'`).
   * Empty / unset = no children may be spawned (fail-closed).
   *
   * Replaces `Agent.spec.allowedChildAgents` +
   * `Agent.spec.allowedChildTemplates` from v0.1.x — those fields
   * remain READABLE for one release with deprecation warning when
   * `capabilityClaims` is set on the same Agent.
   */
  readonly spawn?: readonly string[];

  /**
   * Read targets — CAS URIs and Workspace names. Patterns may be globs:
   * `'cas://*'` admits all artifacts; `'workspace:seekarc-*'` admits
   * all workspaces with that prefix. Empty / unset = no reads
   * permitted.
   */
  readonly read?: readonly string[];

  /**
   * Write targets — same shape as `read`. Empty / unset = no writes
   * permitted. The CAS write target is canonicalized as `'cas://'`
   * (no trailing wildcard) — write-by-content-hash is post-hoc by
   * definition; the prefix carries the intent.
   */
  readonly write?: readonly string[];

  /**
   * Egress hostnames the agent loop's HTTP-tool family is allowed to
   * reach. Examples: `'api.github.com'`, `'*.googleapis.com'`. Patterns
   * may be globs. Empty / unset = no egress permitted.
   *
   * Replaces `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS` env from v0.1.x
   * — that env remains READABLE for one release with deprecation
   * warning when `capabilityClaims.egress` is set on the same Agent.
   */
  readonly egress?: readonly string[];

  /**
   * Tenant scope — opaque tenant identifier. The substrate does NOT
   * narrow on tenant in v0.3.0 (Tenancy is Wave 4); the field is
   * carried so Tenancy can flip it on without a CRD bump. Single
   * string (NOT a glob list) by design — a task either has one
   * tenant or none.
   */
  readonly tenant?: string;

  /**
   * Pub/sub topic-publish targets — Wave 3 Events surface. Patterns
   * may be globs (`'kagent.events.*'`). Empty / unset = no publish.
   * Field is reserved here so Wave 3 can wire it without a CRD bump.
   */
  readonly publish?: readonly string[];

  /**
   * Pub/sub topic-subscribe targets — Wave 3 Events surface. Same
   * shape + reservation rationale as `publish`.
   */
  readonly subscribe?: readonly string[];
}

/**
 * The fully-decoded capability bundle JWT payload. Carries the
 * standard JWT registered claims (per RFC 7519 §4.1) plus the
 * substrate's `claims` subobject.
 *
 * Field semantics:
 *   - `iss`   — REQUIRED. Convention: `kagent.knuteson.io/operator`
 *               (the substrate's operator-CA identity).
 *   - `sub`   — REQUIRED. The subject this capability authorizes.
 *               Convention: `task-uid:<uid>` for AgentTask-scoped caps,
 *               `workflow-uid:<uid>` for AgentWorkflow-scoped caps
 *               (Wave 2 Workflows).
 *   - `aud`   — REQUIRED. Audience: ALWAYS `['kagent-substrate']`
 *               for v0.3.0; Wave 4 Tenancy may add `tenant:<name>`.
 *   - `exp`   — REQUIRED. Unix epoch seconds; verifier MUST refuse
 *               expired bundles. Issuer chooses TTL per spec §3.6
 *               (recommended: parent task's deadline + slack).
 *   - `iat`   — RECOMMENDED. Unix epoch seconds.
 *   - `nbf`   — OPTIONAL. Unix epoch seconds; defaults to `iat`.
 *   - `jti`   — REQUIRED. Unique capability id; convention
 *               `cap-<base32-or-uuid>`. Stored on
 *               `AgentTask.status.capabilityRef` so revocation +
 *               forensics can re-find the bundle by id.
 *   - `claims` — REQUIRED. The substrate's per-category authority
 *                shape (above).
 */
export interface CapabilityBundle {
  readonly iss: string;
  readonly sub: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly jti: string;
  readonly claims: CapabilityClaims;
}

/**
 * Lightweight reference to a capability bundle — the `<jti>`. Stored
 * on `AgentTask.status.capabilityRef` so a status reader can re-fetch
 * the full bundle from the operator's capability registry without
 * re-shipping the JWT through etcd. Stringly typed by design (it's
 * a JWT id, not a structured ref).
 */
export type CapabilityRef = string;

/**
 * Claim category names — useful for audit-event tagging
 * (`capability.used` carries `claim: <category>`).
 */
export type CapabilityClaimCategory =
  | 'tools'
  | 'models'
  | 'spawn'
  | 'read'
  | 'write'
  | 'egress'
  | 'tenant'
  | 'publish'
  | 'subscribe';

/**
 * Frozen array of every claim category — used by the test suite + the
 * deprecation shim ("walk every claim category and check whether the
 * caller specified anything").
 */
export const ALL_CAPABILITY_CLAIM_CATEGORIES = Object.freeze([
  'tools',
  'models',
  'spawn',
  'read',
  'write',
  'egress',
  'tenant',
  'publish',
  'subscribe',
] as const) as readonly CapabilityClaimCategory[];

/**
 * The substrate's locked audience value — every cap minted at v0.3.0
 * MUST include this. Wave 4 Tenancy will add `tenant:<name>` as a
 * second audience element; this constant stays the substrate baseline.
 */
export const KAGENT_SUBSTRATE_AUDIENCE = 'kagent-substrate' as const;
