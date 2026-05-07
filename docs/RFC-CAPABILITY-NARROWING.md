# RFC — Capability narrowing at the K8s spawn boundary

**Status:** discussion seed (NOT a KEP — see §7).
**Reference date:** 2026-05-07.
**Audience:** maintainers of `kubernetes-sigs/agent-sandbox`, SIG Apps, Red Hat Kagenti contributors, anyone watching the K8s-native agent surface.
**Author:** Chris Knuteson (`cknuteson@gmail.com`), `ctkadvisors/kagent` maintainer.
**Companion docs:** [`UPSTREAM-DIFF-AGENT-SANDBOX.md`](./UPSTREAM-DIFF-AGENT-SANDBOX.md) §5.1, [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.6, [`evidence/audit-rev2/R1.md`](../evidence/audit-rev2/R1.md) §5.2.

> The point of this document is to put a concrete proposal on the table so the SIG can argue with shape, not vibes. kagent ships one design today; the SIG might pick a different one. Either is a better outcome than every consumer reinventing this in private. **The asks are tagged `SIG-ASK-N` for ease of reference in issue threads.**

---

## 1. Why this RFC

### 1.1 The gap is uncontested

As of 2026-05-06, the `kubernetes-sigs/agent-sandbox` repo has:

- **Two open KEPs**: `174-metadata-propagation`, `359-refactor-python-sdk` (verified via `gh api repos/kubernetes-sigs/agent-sandbox/contents/docs/keps`).
- **Zero open issues** matching "capability", "narrow", "authority", "JWT", or "SPIFFE" in the title (verified via `gh issue list --search`). Issue #243 mentions mTLS, but for external client access; #384 covers env-vars-and-secrets on `SandboxClaim`, but does not address spawn-time authority narrowing.

This matches the rev2 audit finding in `evidence/audit-rev2/R1.md` §5.2: kagent's prior R1.4 #4 conclusion ("no other surveyed OSS project ships caveat-narrowing JWT capabilities at the K8s spawn boundary") is **still valid as of 2026-05-06**, with the gap unchanged across the v0.4.x release cadence (v0.3.10 → v0.4.5 in ~30 days, all of which expanded lifecycle/warm-pool/snapshot semantics — none of which touched authority).

### 1.2 What other projects ship is adjacent, not equivalent

The rev2 audit (`R1.md` §5.2) catalogues the relevant adjacent designs:

- **AgentField** (1.6k★, Apr/May 2026) — W3C-DID issuance-time identity per agent + verifiable-credential audit trail. **Issuance-time, not narrowing-on-spawn.** A child agent receives its own DID; there is no enforced relationship between `child.credentials` and `parent.credentials`.
- **Red Hat Kagenti** (201★, v0.5.1 Mar 2026) — Keycloak RFC-8693 token exchange. Strong SPIFFE/SPIRE story; the token exchange is gateway-call-time, not spawn-time. Narrowing happens at the audience, not at the child's authority surface.
- **Microsoft Agent Framework 1.0 GA** (10.2k★, Apr 2026) — Ed25519 plugin signatures via the Agent Governance Toolkit. Signs *what plugins are allowed to load*, not *what authority a spawned child inherits*.
- **AWS Cedar** — policy evaluation at the Gateway; not at the K8s spawn boundary.
- **Macaroons** (2014 paper) — caveat-narrowing primitive that exists as a concept but has no K8s-native operator implementation.
- **Solo.io kagent enterprise** (commercial; not OSS) — the kagent **enterprise** distribution ships controller-minted RS256 JWTs with JWKS publication at `/jwks.json` for **on-behalf-of (OBO)** identity exchange ([`docs.solo.io/kagent-enterprise/docs/latest/security/obo/`](https://docs.solo.io/kagent-enterprise/docs/latest/security/obo/), verified 2026-05-07). The wire shape — operator-CA-signed JWT + JWKS at a well-known URL — matches kagent's capability primitive almost exactly. **The semantic is different: OBO is identity-on-behalf-of (a service-attributable token authorizing the agent to act on a user's behalf), NOT `child.claims ⊆ parent.claims` enforcement at the spawn boundary.** Both primitives are valuable in K8s-agent operator design — identity-OBO answers "who is this agent acting for"; capability-narrowing-on-spawn answers "what authority did the parent admit this child to inherit." Only kagent's OSS primitive enforces the narrowing rule at the K8s admission boundary; the rest of this RFC presumes the SIG audience cares about the narrowing semantic specifically.

**None of these enforces `child.claims ⊆ parent.claims` at the K8s-controller admission boundary, with a substrate-issued + substrate-verified token, in the way kagent does.** That is a real gap.

### 1.3 Two convergent K8s-native operators do not address the gap either

Both `kubernetes-sigs/agent-sandbox` and Solo.io `kagent.dev/agent` (different project, name collision noted in `CLAUDE.md`) have shipped meaningful per-pod-isolation primitives. Both ship a `Sandbox`/`SandboxAgent` CRD that owns the per-agent pod. Neither ships a capability primitive. A consumer that wants both isolation AND spawn-time authority narrowing today must compose isolation from agent-sandbox with capability machinery from kagent (or build their own) — which is the real-world motivation for writing this down.

### 1.4 What this RFC is, and is not

- **Is:** a discussion seed, willing to be wrong about every shape choice. kagent's existing implementation is one possible design, not THE design.
- **Is not:** a KEP. KEPs come from inside the SIG, not from external consumers. The shape this RFC proposes (start with a SIG discussion issue → KEP → code) is laid out in §7.
- **Does:** name the threat model, the wire shape, and the open questions explicitly so the conversation has a starting point.
- **Does not:** prescribe which of three wire-shape options the SIG should pick (§3 is explicit "pick one"); does not assume the SIG will adopt JWT specifically over (e.g.) Biscuit, COSE-attested CWT, SPIFFE JWT-SVID with custom claims, or Macaroon-style caveat chains.

---

## 2. The primitive

A **sealed JOSE JWT** issued by the substrate (controller-side) at task spawn, mounted into the spawned pod as a Secret-volume file, verified by the pod against a JWKS the substrate publishes at a well-known URL. The JWT's `claims` block names every right the spawned task has — which tools, which models, which artifacts to read or write, which Agent names it may itself spawn, which workspaces it may mount, which egress domains it may reach.

### 2.1 Algorithm

ES256 (P-256 ECDSA + SHA-256) by default; RS256 (RSA-2048+) as the fallback when the chart provisioned an RSA key (some cert-manager Issuers default RSA). See `packages/operator/src/cap-ca.ts:32-37, 349-357` in the kagent reference implementation. The `kid` header is stamped on every minted JWT and on the JWK in the JWKS so verifiers can resolve a single key without trying every entry.

Alg choice is one of the open questions for the SIG (§5).

### 2.2 Claim shape

```jsonc
{
  "iss": "kagent.knuteson.io/operator",   // substrate identity
  "sub": "task-uid:abc123",                // the AgentTask UID
  "exp": 1735689600,                       // short TTL — minutes-to-hours, not days
  "jti": "cap-abc123",                     // unique per mint, recordable for revoke
  "aud": ["kagent-substrate"],             // audience-restrict
  "claims": {
    "tools":   ["http_get", "write_artifact", "spawn_child_task"],
    "models":  ["gpt-4o", "claude-3.5-sonnet"],
    "spawn":   ["summarizer-*", "validator"],         // glob patterns over Agent names
    "read":    ["cas://*", "workspace:seekarc-*"],    // resource-URI globs
    "write":   ["cas://", "workspace:seekarc-pr-1234"],
    "egress":  ["api.github.com"],                    // hostname patterns
    "publish": ["research.findings"],                 // pub/sub topic patterns
    "subscribe": ["research.priorities"],
    "tenant":  "acme"                                 // substrate-attributable; ungrabbable
  }
}
```

The claim-category set is application-shaped: kagent has seven primitives (`SUBSTRATE-V1.md` §3) and each gets a claim category. A SIG-level shape might choose a smaller default set and let consumers extend.

### 2.3 The narrowing rule

**`child.claims ⊆ parent.claims`** — the substrate refuses to mint a child capability whose claim-set is not a subset of the parent's (intersection-by-default, no explicit-grant escape hatch). Enforced at admission; the spawning agent's pod cannot re-grant authority it does not itself hold.

In the kagent reference implementation:

- Operator-side admission (`packages/operator/src/cap-issuer.ts:1-130`) intersects `Agent.spec.capabilityClaims` with the parent's verified bundle at mint time; rejects if intersection is empty for a category the parent declared non-empty.
- Pod-side spawn-tool enforcement (`packages/agent-pod/src/builtin-tools-spawn.ts:260-294`) refuses with `policy_denied:capability_violation` when the requested child-Agent name isn't admitted by `parent.cap.claims.spawn`.
- Defense-in-depth: when the parent declares a non-empty `Agent.spec.allowedChildAgents` (a GitOps-controlled list orthogonal to the cap), the spawn tool ALSO enforces that list — the cap and the legacy list both must admit the target name. This is the M6 fix (commit `81419f0`); see §4 below.

### 2.4 Verification + revocation

- **JWKS publication:** operator publishes its current public key(s) at `/.well-known/jwks.json`. JWKS supports a primary + secondary key for rotation cutover (verifiers cached against the previous primary still succeed during cutover; `cap-ca.ts:200-215`).
- **Verification:** consumer fetches JWKS lazily on first cap load, caches in memory. See `packages/agent-pod/src/cap-consumer.ts:101-220`.
- **Revocation:** kagent today relies on **short TTL only** (TTL is `runConfig.timeoutSeconds + 60s` plus a tier override from the keyrotation controller). A jti-revocation list is not implemented. This is one of the open questions in §5 — for a substrate that can guarantee task durations of minutes, short TTL is enough; for long-running Sandbox-shaped workloads, a revocation list may be necessary.

---

## 3. Wire shape — three options for the SIG to pick from

The kagent implementation is operator-issued + pod-Secret-volume-mounted because that's what kagent's CRD shape (Agent + AgentTask) supports cleanly. For `kubernetes-sigs/agent-sandbox`'s shape (Sandbox + SandboxClaim + SandboxTemplate), the same primitive could land in any of three ways. This list is intentionally non-exhaustive; the SIG might prefer a fourth.

### Option A — extend `Sandbox.spec` with a capability field (tightest coupling)

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: Sandbox
spec:
  podTemplate:
    ... # existing
  capability:
    issuer: "https://capability-issuer.example.com"   # JWKS publisher
    audience: "agents.x-k8s.io/sandbox"
    claims:
      tools:   ["http_get"]
      spawn:   ["summarizer-*"]
      egress:  ["api.github.com"]
    parentJti: "cap-parent-xyz"   # set by the controller of the spawning Sandbox; absent = root
```

The Sandbox controller would call out to the named issuer (or to a sidecar issuer) at admission time, mint a JWT, and inject it as a Secret-volume mount into the pod. Verification is the consumer's responsibility.

**Pros:** tight integration; the Sandbox CR fully describes the workload's authority surface.
**Cons:** couples the Sandbox controller to a capability concept it might not want to own; the issuer becomes a hard dep.

**SIG-ASK-1:** does SIG Apps want capability-as-a-field on the existing Sandbox CR, or should it be a separate CR?

### Option B — standalone `Capability` CR + binding policy (loosest coupling)

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: Capability
metadata:
  name: cap-task-abc123
spec:
  parentRef:
    kind: Capability
    name: cap-parent-xyz   # absent = root
  claims:
    tools:   ["http_get"]
    spawn:   ["summarizer-*"]
    egress:  ["api.github.com"]
status:
  jti: "cap-abc123"
  jwtRef:
    kind: Secret
    name: cap-task-abc123-jwt
  expiresAt: "2026-05-08T12:00:00Z"
---
apiVersion: agents.x-k8s.io/v1alpha1
kind: SandboxCapabilityBinding
metadata:
  name: bind-claim-foo
spec:
  sandboxClaimRef: { name: claim-foo }
  capabilityRef:   { name: cap-task-abc123 }
  mountPath: "/var/secrets/cap/cap.jwt"
```

The Sandbox + SandboxClaim controllers stay untouched. A separate `Capability` controller mints + signs + GCs JWTs. A `SandboxCapabilityBinding` CR is the seam — the binding controller mounts the JWT Secret into the pod that the SandboxClaim materialized.

**Pros:** zero changes to the existing Sandbox / SandboxClaim API; capability becomes a composable optional layer; consumers who don't want it pay no cost.
**Cons:** more CRs to learn; the binding controller has to coordinate with the SandboxClaim controller's pod-creation lifecycle (race window).

**SIG-ASK-2:** if a separate CR, is the SIG OK owning a third controller (alongside Sandbox + SandboxClaim), or would a sub-project / separate repo be cleaner?

### Option C — admission webhook injects JWT into labeled pods (zero-CR)

A mutating admission webhook watches for pods carrying `agents.x-k8s.io/capability-claim: <claim-name>` and injects a JWT-volume + env-var pointing at the mount. The claim itself lives in a `ConfigMap` or in a label-encoded JSON blob.

**Pros:** zero new CRDs; works against any pod-shaped workload, not just Sandbox; cleanest fit for the existing webhook discipline in the K8s ecosystem.
**Cons:** webhooks have well-known operational sharp edges (failure-policy=Fail risks cluster-wide pod-creation outages; failure-policy=Ignore = silent bypass); claim representation in a label/ConfigMap is awkward for the typed-array claim categories.

**SIG-ASK-3:** is the SIG comfortable with a webhook-based design here, or has the project's prior experience steered away from webhook-injected primitives?

### Recommendation (kagent's bias)

Option B feels cleanest for `kubernetes-sigs/agent-sandbox`'s scope-disciplined posture — the existing Sandbox CR is laser-focused on isolation, and capability-narrowing is a separable concern. But the SIG's view of "what belongs in the Sandbox API surface vs. what belongs in extensions/" trumps an outside opinion. We'd be glad to prototype any of the three.

---

## 4. Threat model

### 4.1 What the primitive defends against

- **Lateral movement via runaway delegation.** A compromised agent cannot grant itself or its children authority it doesn't itself hold. The substrate enforces `child.claims ⊆ parent.claims` at admission; the agent code is not in the trust path.
- **GitOps allowlist bypass.** kagent's M6 finding (`evidence/audit-rev2/C2.md` row M6, fixed in commit `81419f0`) — "a cap with `claims.spawn = ['*']` bypassed the GitOps-controlled `Agent.spec.allowedChildAgents` list" — is exactly the failure mode this primitive must defend against. The fix shape: enforce the cap AND the legacy GitOps list when the operator declared it. The general lesson: capability narrowing is **defense-in-depth alongside** GitOps-managed allowlists, not a replacement for them. A naive cap implementation that treats the JWT as the sole authority surface will defeat operator-author intent.
- **Exfiltration via spawn-then-reach.** A summarizer agent that has `claims.read = ["cas://*"]` but `claims.egress = []` cannot spawn a child with `claims.egress = ["evil.example.com"]` to bounce data out — the child's egress claim must be a subset of the parent's empty set, which is the empty set.
- **Blast radius reduction on agent-loop bugs.** A model that hallucinates a tool name not in `claims.tools` gets `policy_denied` instead of an unguarded execution; the failure is loud and substrate-attributed.

### 4.2 What the primitive does NOT defend against

This is the load-bearing list — please add to it; security primitives die quietly when their threat model is overstated.

- **Out-of-band JWT theft.** If the JWT file leaks (volume permissions misconfigured, sidecar reads the mount, log capture pulls in the mounted file), an attacker has the full authority surface until the cap expires. Mitigation: short TTL (minutes-to-hours); audit-stream every cap mint and gateway use of cap-id.
- **Prompt-injection bypass.** The cap gates *what tools the agent can call*, not *what arguments the agent passes*. A tool-confused agent calling `http_get` against a URL it shouldn't is well-formed cap-wise. Mitigation: the cap is one layer; argument-level filters are application-layer (or another substrate primitive — kagent has detector-layer middleware in `packages/agent-loop/src/detectors/`).
- **Kernel exploit / sandbox escape.** Capability narrowing is a K8s-API-layer primitive; it does nothing if the runtime sandbox itself is compromised. Mitigation: that's what `RuntimeClass: kata` / gVisor exist for.
- **Issuer compromise.** If the substrate's signing key leaks, every JWT is forgeable. Mitigation: cert-manager-managed signing keys, JWKS rotation cutover (kagent supports `secondaryPublicPem` for the cutover window), short cap TTL ensures forged caps expire fast.
- **Replay within TTL window.** A captured JWT can be replayed against the substrate-internal verifier path until `exp`. Mitigation: short TTL; jti-binding to the AgentTask UID (kagent's `sub` field is `task-uid:<uid>` — verifiers can reject JWTs whose `sub` mismatches the requesting task identity); revocation list (open question, §5).
- **Supply-chain compromise of the issuer or verifier code.** The cap-issuer running malicious code can mint over-broad caps; the cap-consumer running malicious code can ignore the bundle entirely. Mitigation: image signing, controller code review, runtime attestation. Out of scope for this RFC.
- **Side-channel inference of claim shape.** A long-lived attacker can probe what tools a target agent has by observing which `tool_call`s succeed and which return `policy_denied`. Mitigation: not addressed; this is observable via traces anyway.

### 4.3 Concrete known-weakness mitigated by the latest kagent fix

The M6 finding above is worth restating because it's a real-world demonstration of the threat model: **a cap-permissive deploy + a GitOps-controlled allowlist must compose correctly**. Treating the cap as the sole authority when the operator has also written a narrower GitOps list defeats the operator's intent. The fix (commit `81419f0`, `packages/agent-pod/src/builtin-tools-spawn.ts:283-294`):

```typescript
// Defense-in-depth fix: ALSO enforce allowedChildAgents /
// allowedChildTemplates when the parent has a cap, BUT ONLY when
// those lists are non-empty. The "cap-only deploy" pattern (both
// lists intentionally empty, cap is the sole authority) is
// preserved by the `allow.size > 0 || allowTemplates.size > 0`
// gate — only enforce the legacy lists when the operator
// declared them. Both narrowing rules apply: cap claims AND
// allowedChild* lists must each admit the target name.
const enforceLegacyLists =
  parentCap === undefined || allow.size > 0 || allowTemplates.size > 0;
```

If the SIG adopts the primitive, this composability with whatever-other-allowlists-exist needs to land in the spec, not just the implementation.

---

## 5. Open questions

These are the questions kagent would want a SIG conversation to resolve before adoption. None has an obvious right answer.

### 5.1 Algorithm choice — ES256, Ed25519, or COSE/CWT?

kagent ships ES256 (default) and RS256 (fallback). Ed25519 has smaller signatures, faster verify, no malleability concerns; it's a JOSE-defined alg (`EdDSA`) but adoption in K8s tooling is uneven. CWT (CBOR Web Token, RFC 8392) is binary-encoded and smaller on the wire; SPIFFE JWT-SVID convention is JWT-based and might align well. **SIG-ASK-4:** what's the SIG's posture?

### 5.2 Claim taxonomy — substrate-defined or application-defined?

kagent's claim categories (`tools/models/spawn/read/write/egress/publish/subscribe/tenant`) reflect kagent's seven primitives. SIG-Apps consumers might have different primitives. Options:

- (a) **Substrate-defined fixed set** — small SIG-blessed set (e.g. `tools`, `egress`, `spawn`, `tenant`), other categories rejected by the verifier.
- (b) **Substrate-defined + application-extended** — small mandatory set + opaque `extensions: { ... }` map for consumer-specific.
- (c) **Fully application-defined** — substrate enforces only the structural rules (subset, glob match); the category names are opaque strings.

**SIG-ASK-5:** the trade-off is interop (mandatory set across consumers) vs. flexibility (consumer-defined category names). kagent has a slight bias toward (b) but is genuinely uncertain.

### 5.3 Narrowing semantics — strict intersection or explicit-grant escape hatch?

kagent ships strict intersection: `child ⊆ parent`, no exceptions. This is a deliberate "fail closed" posture. An alternative shape — where the issuer can grant a child a claim the parent didn't have, gated by a separate grant — exists in some capability systems (Macaroons "third-party caveats", Biscuit attenuation). **SIG-ASK-6:** does SIG Apps want the simpler strict-intersection semantics, or is there a consumer use case for explicit-grant?

### 5.4 Revocation — jti-list or short-TTL only?

kagent today: short TTL only (`runConfig.timeoutSeconds + 60s` plus a tier override, capped at hours). No jti-revocation. For Sandbox-shaped workloads (long-lived stable singletons), short TTL may not be enough — a Sandbox running for days needs either rotation (mint a fresh JWT periodically + replace the Secret) or an external revocation check.

Options:

- (a) **No revocation** — TTL only; consumers running long-lived workloads must mint new caps periodically.
- (b) **Periodic rotation** — substrate auto-rotates caps every N minutes by replacing the Secret; the consumer re-reads on a watch.
- (c) **jti-revocation list** — a `RevokedCapabilities` CR (or a ConfigMap) the verifier consults; an out-of-band kill-switch for compromised caps.

**SIG-ASK-7:** which of these (or which combination) fits the Sandbox lifecycle?

### 5.5 JWKS rotation cadence

kagent supports a primary + secondary key in the JWKS for cutover (`cap-ca.ts:165-211`); rotation is operator-driven via the chart's Secret. SIG-blessed cadence (e.g. "rotate every 30 days; cutover window of 5 minutes") would let consumers depend on a known-good behavior. **SIG-ASK-8:** is this a primitive-level concern or a consumer's-cluster-policy concern?

### 5.6 Where does the issuer live?

Three places it could reasonably live:

- (a) Inside the Sandbox controller (Option A above) — tight coupling.
- (b) In a dedicated `Capability` controller (Option B) — composable.
- (c) As an independent service the consumer self-hosts (the controller just consumes JWKS) — most flexible, most setup cost.

**SIG-ASK-9:** SIG-Apps preference?

### 5.7 Audit-stream contract

Every cap mint, every cap-gated tool call, every cap-narrowed spawn should emit a substrate-attributable audit event. kagent emits `capability.minted`, `capability.verified`, `capability.violated`, `spawn.cap_violation` on a NATS JetStream `audit` stream (see `SUBSTRATE-V1.md` §4.3). **SIG-ASK-10:** is the audit-stream-shape an in-scope concern for this RFC, or a separate one (it appears in `UPSTREAM-DIFF-AGENT-SANDBOX.md` §5.6 separately)?

---

## 6. Reference implementation — kagent

Citations into the kagent tree at HEAD `fc32b13` (post-rev2-audit, with B1/B2/H7/M6 closed). **kagent's implementation is ahead-of-spec; it might not match the eventual SIG shape.** Sharing the file:line citations so the conversation has concrete artifacts to argue with.

| Concern | File:line | Notes |
|---|---|---|
| CRD shape — the upper bound on what a task can claim | `packages/operator/src/crds/types.ts:282-313` | `Agent.spec.capabilityClaims` field, comments document narrowing rules + each category's semantics |
| Operator-side mint + parent-narrowing | `packages/operator/src/cap-issuer.ts:1-130` | Intersects Agent's claims with parent bundle; signs via `CapCa.mint()` |
| Signing CA + JWKS | `packages/operator/src/cap-ca.ts:1-60, 152-214, 349-357` | ES256/RS256 detection at PEM-load time; primary + secondary key for rotation cutover; JWKS exposed at `/.well-known/jwks.json` |
| Consumer-side verify | `packages/agent-pod/src/cap-consumer.ts:101-220` | Reads JWT from `KAGENT_CAP_JWT_FILE`; fetches + caches JWKS; verifies signature + iss + aud + exp |
| Spawn-time narrowing enforcement | `packages/agent-pod/src/builtin-tools-spawn.ts:260-294` | Refuses with `policy_denied:capability_violation` when target Agent isn't admitted by `cap.claims.spawn` |
| Defense-in-depth with GitOps allowlists | `packages/agent-pod/src/builtin-tools-spawn.ts:283-322` | M6 fix — cap AND `Agent.spec.allowedChildAgents` both must admit when the operator declared the legacy list |
| Tenancy + per-tenant issuer override | `packages/operator/src/cap-issuer.ts:69-114`; `cap-ca.ts:179-195` | v0.5.0-tenancy lets a Tenant CR declare its own `iss` so caps route through a per-tenant subject |
| TTL policy + tiered keyrotation | `packages/operator/src/cap-issuer.ts:96-115` (input shape); `@kagent/keyrotation-controller` package | v0.5.4-keyrotation — short-running / long-running-grace / long-running-clamped tiers; informs the "revocation" question (§5.4) |

The kagent integration test surface for these primitives lives in `packages/agent-pod/src/builtin-tools-publish.test.ts`, `cap-consumer.test.ts`, `tool-allowlist.test.ts`, and the operator-side `cap-issuer.test.ts`.

---

## 7. Adoption path

The kagent owner's working assumption is: **issue first, KEP second, code third.** Concretely:

1. **Open a discussion issue** on `kubernetes-sigs/agent-sandbox` titled along the lines of "RFC: capability narrowing for sandbox-spawned children", linking to this document. Goal: see whether the SIG has appetite, surface objections, identify maintainers who'd want to co-author.
2. **If the issue gets traction** (one maintainer signals interest within ~2 weeks): draft a KEP in `docs/keps/NNNN-capability-narrowing/` against the SIG's existing template (`docs/keps/NNNN-template/`). The KEP, not this RFC, is the SIG's binding artifact.
3. **If the KEP is accepted:** prototype against one of the three wire-shape options from §3. kagent would happily contribute the issuer + verifier code as a starting point if the SIG picks Option B (standalone CR); the existing kagent code is MIT and vendor-neutral apart from naming.
4. **If the issue does NOT get traction:** kagent continues to ship its reference implementation and tries again in 6 months. The primitive is too useful to abandon, but the SIG's scope discipline (kagent admires it) is the SIG's call to make. Path 3 in `UPSTREAM-DIFF-AGENT-SANDBOX.md` §6 ("coexist + cross-reference") is a perfectly fine outcome from kagent's side.

We'd rather argue this in public — pull-requests-and-issues-shaped — than in private. kagent's owner is `@cknuteson` on GitHub; the maintainer is reachable at `cknuteson@gmail.com`. Thank you for building `kubernetes-sigs/agent-sandbox`; it's the K8s-native primitive the agent-platform space needed and it's why writing this RFC felt worth the time.

---

## Appendix A — terms used

- **JOSE** — JavaScript Object Signing and Encryption; the IETF JWT/JWS/JWE family.
- **JWKS** — JSON Web Key Set; the public-key publication format JOSE verifiers consume.
- **ES256** — ECDSA P-256 + SHA-256; default JOSE alg for short signatures.
- **RS256** — RSA-2048+ + SHA-256; legacy JOSE alg, larger signatures, faster verify.
- **kid** — Key ID in JOSE; lets verifiers resolve a single key in a multi-key JWKS without trial.
- **Caveat-narrowing** — terminology from Macaroons (Birgisson et al., 2014); the primitive that lets a capability-holder produce a strictly-less-powerful capability without contacting the issuer.
- **substrate** — kagent's term for the K8s controller layer that owns lifecycle + identity + audit, distinct from application code that runs inside the spawned pod. `SUBSTRATE-V1.md` is the contract.

## Appendix B — change log

- **2026-05-07:** initial draft (this RFC) seeded from `evidence/audit-rev2/R1.md` §5.2 and the kagent rev2-hardened reference implementation.
