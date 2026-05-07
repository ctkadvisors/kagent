# RENAME-EVALUATION.md

**Authored:** 2026-05-07 (W4-Strategy-Name, audit-rev2 punchlist S2)
**Inputs:** `CLAUDE.md` § "Naming note"; `evidence/audit-rev2/R1.md` §6.4 ("naming-collision question is now urgent").
**Posture:** evidence-led, decision-deferred. Surfaces availability + conflict data so the user can choose. Does not pick a winner.
**Out of scope:** the actual rename / migration plan. Once a candidate is chosen, that is a separate workstream (repo rename, package-name flip across `packages/`, CRD `apiVersion` decisions, K8s `app.kubernetes.io/name` labels, Helm chart name, container image registry path, Argo `Application` names in `../new_localai/`, GitHub repo redirect, etc.).

---

## 1. Why this evaluation exists

The internal codename `kagent` (Knuteson + agent) collides directly with **Solo.io's `kagent`** ([github.com/kagent-dev/kagent](https://github.com/kagent-dev/kagent), [kagent.dev](https://kagent.dev)), which is a Kubernetes-native agentic-AI framework focused on cluster operations.

Per `evidence/audit-rev2/R1.md` §6.4 ("Recommendations for kagent's positioning narrative", item 4):

> Solo.io kagent.dev is shipping at v0.9.x cadence (4 releases in ~2 weeks) — with v0.9.0 specifically adding `SandboxAgent` integration with kubernetes-sigs/agent-sandbox. The naming-collision question is now urgent. Solo.io's kagent has 2,689★, ships every few days, and is the canonical "kagent" in Google search results. The rename evaluation in `CLAUDE.md` § "Naming note" should not wait for public release.

Material since R1 was written:
- Solo.io's `kagent` is now on **v0.9.2 (2026-05-07)** with `SandboxAgent`, `AgentHarness`, `RemoteMCPServer` CRDs ([release notes](https://kagent.dev/docs/kagent/resources/release-notes)).
- Solo.io's `kagent` is also a **CNCF sandbox project** ([Solo.io blog: Contributing Kagent to CNCF](https://www.solo.io/blog/bringing-agentic-ai-to-kubernetes-contributing-kagent-to-cncf)).
- Google's "kagent" SERP and the [kagent | Bringing Agentic AI to cloud native](https://kagent.dev/) result are entirely Solo.io's project.

Cost of NOT renaming before public release: search dilution; legal/trademark exposure; "second kagent" forever explanations; CNCF-landscape submission rejection (a CNCF sandbox already owns the name).

This document weighs candidates from `CLAUDE.md` § "Naming note" — `agentforge`, `kfarm`, `agentpod`, `podforge` — plus additional candidates uncovered during this evaluation.

---

## 2. Evaluation criteria

For each candidate:

1. **GitHub org / user availability** — is `github.com/<name>` taken? If yes, by whom and how active?
2. **npm package + scope availability** — registry status of `<name>` and `@<name>`.
3. **`<name>.dev` and `<name>.io` domain status** — DNS resolution and apparent occupancy. Cannot confirm "available for purchase" without registrar query; flagged as **needs whois verify** when DNS suggests unregistered.
4. **Existing project conflicts** — GitHub repos, Google SERP dominance, CNCF landscape entries, PyPI / crates / npm packages by the same name.
5. **Semantic fit** — does the name signal "K8s-native + agent + farm/operator"? Does it preserve any K3s pun? Is it pronounceable, distinguishable from Solo.io's kagent?
6. **Trademark exposure** — quick web/SERP check; flag any active-mark presence. Not a substitute for a real TESS / EUIPO clearance — flagged as **needs trademark counsel** for any seriously-considered candidate.

Scoring rubric used in §4 comparison table:
- **CLEAR** — no observed conflict
- **WEAK** — conflict exists but in a different domain / inactive / low star count
- **STRONG** — high-overlap conflict (same domain space, well-known project, active commercial use, or CNCF entry)

---

## 3. Per-candidate evidence

### 3.1 `agentforge`

**GitHub org:** **TAKEN, ACTIVE.** [github.com/agentforge](https://github.com/agentforge) — 17 repos, primary repo `agentforge` (8★), describes itself as "building infra at the intersection of human cognition and artificial intelligence" with email `info@agentforge.ai` and an active website at agentforge.ai. Activity slowed (last update Feb 2025).

**Other GitHub conflicts (high):**
- [github.com/DataBassGit/AgentForge](https://github.com/DataBassGit/AgentForge) — **788★, GPL-3.0**, "Extensible AGI Framework," PyPI-published as `agentforge`. Last release v0.5.1 Feb 2025.
- [github.com/microsoft/agent-forge](https://github.com/microsoft/agent-forge) — **60★, MIT, Microsoft-owned**, "Context Engineering Toolkit that generates GitHub Copilot customization files." v0.3.0 released Apr 13, 2026 — **Microsoft is actively shipping on this name**.
- [github.com/frostlogic-ab/agent-forge](https://github.com/frostlogic-ab/agent-forge) — TypeScript framework for AI-agent orchestration.
- [github.com/nbsp1221/agentforge](https://github.com/nbsp1221/agentforge) — another agent framework.

**npm:** registry `agentforge` returns HTTP 404 — package is **available**. Scope `@agentforge` also 404 — available.

**PyPI:** **TAKEN** by DataBassGit — [pypi.org/project/agentforge](https://pypi.org/project/agentforge/). Not directly blocking for a TS/Node project but signals the name is broadly claimed.

**Domains:**
- `agentforge.dev` — **ACTIVE**, hosted on Vercel (A=216.150.1.1, ns=ns1.vercel-dns.com.). Page renders "AgentForge — Build & Deploy Autonomous AI Agents." Likely an active commercial offering.
- `agentforge.io` — Cloudflare-fronted, `whois` shows registered 2024-03-09, expires 2027-03-09 (Registrar: Cloudflare, Inc.). Currently **unresolved A-record** (no public site) but the domain is held.
- `agentforge.net` — **ACTIVE**, the canonical home of DataBassGit/AgentForge (788★ project).
- `agentforge.ai` — held by the GitHub `agentforge` org.

**Trademark:** No USPTO TESS hit found in casual search, but `Agent Forge` is being used commercially in multiple places (e.g., [aitech.io/agent-forge/](https://aitech.io/agent-forge/) — "AI Agent Builder & No-Code AI Workflow Platform"). High collision surface.

**Semantic fit:** Generic-good ("forge AI agents") but **does not signal Kubernetes/K3s** at all. Indistinguishable from at least four other agent-framework projects.

**Verdict: STRONG conflict.** Microsoft is actively shipping under this exact name, GPL-3.0 798★ project owns PyPI + .net + GitHub repo, generic-AI startup owns .dev + .ai. Walking into this name post-public-release would be self-inflicted SEO pain.

---

### 3.2 `kfarm`

**GitHub user:** **TAKEN, INACTIVE.** [github.com/kfarm](https://github.com/kfarm) — user ID 17757203, 0 repos, dormant. **Could potentially be reclaimed via GitHub Trademark Policy or by emailing the user**, but cannot be assumed available.

**npm:** registry `kfarm` returns HTTP 404 — **available**. Scope `@kfarm` also 404 — available.

**Domains:**
- `kfarm.dev` — **DNS does not resolve (no A, no NS in `dig +short`)** — `whois` returns ACTIVE status, so the TLD record exists but no nameservers configured publicly. **Needs whois-verify whether actually purchasable.**
- `kfarm.io` — same pattern: no public DNS, whois ACTIVE. **Needs whois verify.**

**Other project conflicts:**
- [github.com/aenix-io/kubefarm](https://github.com/aenix-io/kubefarm) and [github.com/wedos/kubefarm](https://github.com/wedos/kubefarm) — "Kubefarm: Automated Kubernetes deployment and PXE-bootable servers farm" ([aenix.io/kubefarm/](https://aenix.io/kubefarm/), featured on [kubernetes.io blog 2021-12-22](https://kubernetes.io/blog/2021/12/22/kubernetes-in-kubernetes-and-pxe-bootable-server-farm/)). **Different problem domain (PXE / bare-metal farms) but same K8s namespace + similar word.** Confusion risk: "kfarm vs kubefarm" — pronounceable difference is subtle.
- **KFARM Korea** — agricultural exhibition ([kfarm.co.kr](https://kfarm.co.kr/eng/)) run by MESSE ESANG. Different industry, different geography.
- **K-FARM by Klassen Group** — agricultural products ([klassengrp.com/kfarm](https://klassengrp.com/kfarm/)). Different industry.

**Trademark:** No software-mark hit observed. Two agriculture-mark uses exist; agriculture is far enough from cloud-native that it is unlikely to block, but **needs trademark counsel** before public release.

**Semantic fit:** **Preserves the K3s pun** (`k` = Kubernetes/K3s, `farm` = many isolated workers). Reads as "Kubernetes farm of agents" — fits the substrate framing. Pronounceable. Differentiated from Solo.io kagent.

**Verdict: WEAK conflict.** GitHub user is reclaimable-or-irrelevant; npm clear; .dev + .io possibly available pending whois; only meaningful overlap is `kubefarm` (different domain). Of all four CLAUDE.md candidates, this one has the cleanest substrate-engineering signal AND the cleanest software-namespace.

---

### 3.3 `agentpod`

**GitHub user:** **TAKEN.** [github.com/AgentPod](https://github.com/agentpod) — placeholder account, 0 repos, but exists. Reclamation is more uncertain than a 0-repo user.

**npm:** **TAKEN.** Package `agentpod` (v1.0.0, last published 2026-02-17, maintainer `afshinmeh`, no description). The package being recent and active is a near-blocker — `npm install agentpod` already resolves to someone else.

**Domains:**
- `agentpod.dev` — DNS resolves (A=178.105.68.68, ns=Porkbun) — **TAKEN**, but TLS cert mismatch suggests no production site yet. Held by someone.
- `agentpod.io` — `whois` shows registered 2025-08-21 to 2026-08-21 (Cloudflare). Domain held.

**Other project conflicts:**
- **`kagenti/kagenti-operator`** (Red Hat) — its architecture diagram uses **"Agent Pod"** as the term-of-art for the deployed agent workload (per [github.com/kagenti/kagenti-operator](https://github.com/kagenti/kagenti-operator), v0.2.0-alpha.34 May 7, 2026). Not a CRD literally named `AgentPod`, but the term "Agent Pod" is canonical in their architectural docs. **This is the closest direct collision** — Kagenti is an active Red Hat-sponsored project headed for Red Hat AI H2 2026 (per `evidence/audit-rev2/R1.md` row "Red Hat Kagenti").
- "Agent pool" / "agent pod" is also generic terminology used by Azure Operator Nexus, Octopus, Contrast, New Relic Kubernetes agent products — not a single dominant claim, but heavily overloaded.

**Trademark:** No TESS hit found. "POD" and "PODS" are heavily registered in moving / containers (e.g., PODS Enterprises). Software space appears unclaimed but **needs trademark counsel**.

**Semantic fit:** Reads as "agent + pod" — the unit is correct (one agent, one pod). Loses the K-prefix pun. Distinguishable from Solo.io kagent.

**Verdict: STRONG conflict.** Active recent npm package (Feb 2026, v1.0.0); GitHub user squat; both .dev and .io held; **direct architectural collision with Red Hat Kagenti's "Agent Pod" concept**. Of the four, this is the most contested in the immediate substrate adjacent.

---

### 3.4 `podforge`

**GitHub org:** **TAKEN, ACTIVE.** [github.com/podforge](https://github.com/podforge) — tagline "Simple. Podcasting." with website [podforge.co](https://podforge.co). 0 public repos, but the name is bound to a podcast-publishing concept.

**npm:** registry `podforge` returns HTTP 404 — **available**. Scope `@podforge` 404 — available.

**Domains:**
- `podforge.dev` — **ACTIVE** AI-podcast site (5 niche channels, 62 episodes, latest Apr 6, 2026, paid pricing tiers). Cloudflare-fronted (A=104.21.26.157). Per webfetch: an operational AI-news-to-podcast service.
- `podforge.io` — `whois` ACTIVE, no public DNS. **Needs whois verify.**
- `podforge.com` — **ACTIVE**, custom knifemaking business by Dietrich Podmajersky. Different industry; not a software-namespace blocker but the .com is unavailable.

**Other project conflicts:** No CNCF / K8s-namespace conflicts found. The dominant `podforge` use is podcasting / podcast-as-a-service.

**Trademark:** None observed in software / cloud space; podcast-platform use on `.dev` and `.com` would create user-confusion risk in an "AI" SERP context.

**Semantic fit:** Reads as "pod + forge" — could plausibly mean "K8s-pod factory" (good) or "podcast forge" (bad — actual current dominant interpretation). The name does NOT clearly disambiguate from podcasting until you've read the README. Loses the K-prefix pun. Distinguishable from Solo.io kagent.

**Verdict: WEAK-to-STRONG conflict.** Software-namespace appears clean; the `.dev` domain is occupied by an active AI service in an adjacent space (AI + content); SERP for "podforge" will return the AI podcasting platform first, muddying the substrate's own identity.

---

### 3.5 Additional candidates uncovered

#### `kpods`

- **GitHub user:** TAKEN ([github.com/kpods](https://github.com/kpods)), 1 forked repo (serverless dual-protocol — Chinese-language project). Inactive enough to not collide but the name is held.
- **npm:** TAKEN — `kpods` v0.1.0, "show kubernetes pods details," last published 2022-06-19, maintainer `justlaputa`. Squatter-like, low usage, but registered.
- **Domains:** `kpods.dev` and `kpods.io` — no public DNS, whois ACTIVE. **Needs whois verify.**
- **Semantic fit:** preserves K-prefix; reads as "K8s pods." Generic but accurate.
- **Verdict: WEAK.** npm package is dormant but exists.

#### `kforge`

- **GitHub user:** TAKEN but inactive ([github.com/kforge](https://github.com/kforge)), 0 repos.
- **npm:** registry `kforge` returns 404 — **available**.
- **Domains:** `kforge.dev` — no public DNS, whois ACTIVE; `kforge.io` — DNS resolves to GitHub Pages range (185.199.109.153) suggesting some Pages-hosted site exists. **Needs whois verify.**
- **Semantic fit:** preserves K-prefix; "K + forge" reads as "K8s forge / factory." Pronounceable. Distinguishable from Solo.io kagent.
- **Verdict: WEAK.** Likely cleanest of the K-prefix candidates after `kfarm`.

#### `agentfarm`

- **GitHub org:** TAKEN ([github.com/AgentFarm](https://github.com/agentfarm)), 0 public repos, dormant.
- **npm:** registry `agentfarm` returns 404 — **available**. `@agentfarm` also 404.
- **Domains:** `agentfarm.dev` — DNS resolves to UI-DNS (217.160.0.76) — held; `agentfarm.io` — DNS resolves (Namecheap) — held.
- **Semantic fit:** "agent farm" is exactly the substrate metaphor (CLAUDE.md uses the literal phrase: "the K3s-native, OSS, MIT-licensed agent farm operator"). Loses the K-prefix.
- **Verdict: WEAK-to-STRONG.** GitHub org squat + both domains held. NPM clear. Worth a whois inquiry on which is for sale.

#### `agentmesh`

- **GitHub org:** TAKEN ([github.com/agentmesh](https://github.com/agentmesh)), 0 public repos.
- **npm:** registry `agentmesh` returns 404 — **available**.
- **Domains:** `agentmesh.dev` (Porkbun, A=44.227.76.166) and `agentmesh.io` (Vercel, A=76.76.21.21) — both held.
- **Semantic fit:** **clashes with the A2A "agent mesh" framing** that Solo.io is itself promoting ([Architecting Open Source and Enterprise AI Agent Meshes](https://kagent.dev/blog/inside-kagent-oss-ent-ai-meshes)). Adopting "agentmesh" would walk directly into Solo.io's own next-narrative.
- **Verdict: STRONG.** Reject — it's the exact term Solo.io kagent's marketing uses.

#### `agentvm`

- **GitHub user:** TAKEN, active developer with 10 repos ([github.com/Agentvm](https://github.com/agentvm)) — game development / point cloud, not agents. Not a software-namespace conflict but the handle is occupied.
- **npm:** registry `agentvm` returns 404 — **available**.
- **Domains:** `agentvm.dev` (name.com) and `agentvm.io` (AWS) — both DNS-resolve, held.
- **Semantic fit:** reads as "agent virtual machine" — accurate to the Kata-microVM substrate. Distinguishable from Solo.io kagent.
- **Verdict: WEAK.** Domains held but software namespace clean.

#### `kagenti` (cousin name)

- **STRONG, immediate reject.** Already a Red Hat OSS project ([github.com/kagenti/kagenti](https://github.com/kagenti/kagenti)). Same as the Solo.io collision but more direct. Listed for completeness only.

---

## 4. Comparison table

Legend: **CLEAR** ✓ / **WEAK** ~ / **STRONG** ✗ / **needs whois verify** ?

| Candidate | GitHub org | npm pkg | npm scope | `.dev` domain | `.io` domain | Existing project conflicts | Semantic fit | Trademark risk |
|---|---|---|---|---|---|---|---|---|
| `agentforge` | ✗ taken+active ([gh.com/agentforge](https://github.com/agentforge)) | ✓ 404 | ✓ 404 | ✗ active commercial site | ✗ held (Cloudflare, exp. 2027) | ✗ Microsoft `agent-forge` 60★ MIT, DataBassGit `AgentForge` 788★ GPL3, PyPI `agentforge`, multiple commercial "Agent Forge" platforms ([aitech.io](https://aitech.io/agent-forge/), [agentforge.net](https://agentforge.net/)) | ~ generic AI; no K8s signal | ✗ multiple active commercial uses; needs counsel |
| `kfarm` | ~ taken inactive ([gh.com/kfarm](https://github.com/kfarm), 0 repos) | ✓ 404 | ✓ 404 | ? whois ACTIVE, no DNS | ? whois ACTIVE, no DNS | ~ Kubefarm ([aenix-io/kubefarm](https://github.com/aenix-io/kubefarm)) different problem; KFARM Korea agriculture exhibit; K-FARM Klassen agriculture | ✓ K-prefix pun + farm metaphor; matches CLAUDE.md "agent farm" framing | ~ agriculture-only marks; software-clear; needs counsel |
| `agentpod` | ~ taken empty ([gh.com/agentpod](https://github.com/agentpod), 0 repos) | ✗ TAKEN — v1.0.0 (2026-02-17), active maintainer `afshinmeh` | ✓ 404 | ✗ held (Porkbun) | ✗ held (Cloudflare, exp. 2026-08) | ✗ **direct architectural collision with [Red Hat Kagenti](https://github.com/kagenti/kagenti-operator) "Agent Pod"** term-of-art; generic in K8s monitoring (Contrast, NewRelic) | ~ accurate (1 agent, 1 pod) but loses K-prefix | ~ no software-mark observed; needs counsel |
| `podforge` | ~ taken+empty ([gh.com/podforge](https://github.com/podforge), bound to podcast tagline) | ✓ 404 | ✓ 404 | ✗ active AI podcast service ([podforge.dev](https://podforge.dev)) | ? whois ACTIVE, no DNS | ✗ podcast-AI service dominant in `.dev` SERP; knifemaking business on `.com` | ~ ambiguous between K8s-pod and podcast; loses K-prefix | ✓ none observed; needs counsel |
| `kpods` | ~ taken inactive (1 forked repo) | ✗ TAKEN — v0.1.0 (2022) dormant | ✓ 404 | ? whois ACTIVE, no DNS | ? whois ACTIVE, no DNS | ~ dormant npm; no other significant conflicts | ✓ K-prefix; literal | ✓ none observed |
| `kforge` | ~ taken inactive (0 repos) | ✓ 404 | ✓ 404 | ? whois ACTIVE, no DNS | ✗ DNS to GitHub Pages — held | ~ no significant project conflicts | ✓ K-prefix; reads as K8s factory | ✓ none observed |
| `agentfarm` | ~ taken empty (0 repos) | ✓ 404 | ✓ 404 | ✗ held (UI-DNS) | ✗ held (Namecheap) | ~ none significant; both domains squatted | ✓ literal CLAUDE.md framing ("agent farm") | ✓ none observed |
| `agentmesh` | ~ taken empty (0 repos) | ✓ 404 | ✓ 404 | ✗ held (Porkbun) | ✗ held (Vercel) | ✗ **Solo.io kagent's own "AI agent mesh" terminology** | ~ but maps to competitor's positioning | ✓ none observed |
| `agentvm` | ~ taken active dev (game dev, unrelated) | ✓ 404 | ✓ 404 | ✗ held (name.com) | ✗ held (AWS) | ~ none significant in agent space | ✓ accurate to Kata-microVM substrate | ✓ none observed |

---

## 5. Recommendation: ranked surface for decision

**This is not a unilateral pick — it is a ranked surface of evidence.** Decision is the user's. The audit's R1 §6.4 framed the urgency, not a preferred candidate.

### Tier 1 — fewest conflicts, strongest substrate signal

1. **`kfarm`** — strongest combination of (npm clear, semantic fit with K3s pun + "agent farm" CLAUDE.md framing, no active commercial collision, GitHub user reclaimable). **Required follow-up:** whois on `kfarm.dev` + `kfarm.io` to confirm purchasability; trademark counsel sweep; reach out to GitHub user `@kfarm` (dormant) re: handle availability. Risk: phonetic proximity to `kubefarm` (PXE-boot project).

2. **`kforge`** — second-tightest software-namespace (npm clear, no significant project conflicts, K-prefix preserved). **Required follow-up:** whois on `.dev` (likely available); reclaim `github.com/kforge` (0 repos, dormant). Risk: less semantic punch than `kfarm` — "forge" is more generic.

### Tier 2 — usable but with friction

3. **`agentfarm`** — npm clear, semantic fit literal to CLAUDE.md framing. **Cost:** both `.dev` and `.io` domains are squatted; would require purchase negotiation or settling for `.app` / `.run` / `.cloud` TLD. Loses K-prefix.

4. **`agentvm`** — software namespace clean; semantically accurate (Kata-microVM substrate). **Cost:** both domains held by non-squatters (name.com, AWS); needs domain inquiry. Loses K-prefix.

5. **`podforge`** — npm clear; software-namespace clean. **Cost:** active AI podcast service holds `.dev`; SERP for "podforge AI" returns podcasting first; ambiguous semantics.

### Tier 3 — reject as primary candidate

6. **`agentforge`** — too-many-cooks: Microsoft, DataBassGit (788★ GPL3), multiple commercial AI platforms. Recipe for SEO and trademark pain.

7. **`agentpod`** — npm package recently published (Feb 2026, v1.0.0); both domains held; **direct collision with Red Hat Kagenti's "Agent Pod" architectural term**. Worst overlap with the substrate adjacency.

8. **`agentmesh`** — walks directly into Solo.io kagent's own "AI agent mesh" marketing narrative. Self-defeating.

9. **`kpods`** — npm taken (dormant 2022 package); functional but uninspiring.

### Notes on the decision framing

- **K-prefix retention preserves continuity with `kagent` codename history** but is not necessary if a non-K name carries clearer semantics (e.g., `agentfarm` is more literal than `kfarm` to outsiders who don't grok the K = Kubernetes pun).
- **CLAUDE.md repeatedly uses the phrase "agent farm operator"** — `kfarm` and `agentfarm` are the only candidates that match this self-description.
- **Distinguishability from Solo.io kagent matters more than novelty.** Any of the Tier 1/2 candidates clears the collision; the question is which one the user can stomach long-term.
- **Domain hierarchy preference:** `.dev` is increasingly the cloud-native default; `.io` is the K8s ecosystem default. Both are nice-to-have; neither is strictly required (Solo.io's `kagent.dev` is `.dev`; CNCF projects often run on `.io`).

---

## 6. Out of scope: implementation plan

This document is **evaluation only**. Once the user picks a name, a separate workstream owns:

1. Reserve GitHub org + handle (or reclaim via GitHub Trademark Policy if needed).
2. Reserve npm scope (`@<name>`) and package(s).
3. Purchase domain(s) (`<name>.dev` is highest priority; `<name>.io` second).
4. Repo rename in this workspace + redirect from `kagent` (GitHub auto-handles redirect for repo rename within an org).
5. Package-name rename: `packages/agent-loop` stays as-is; `packages/operator`, `packages/agent-pod`, etc. — search for `kagent` in:
   - `package.json` `name` fields
   - Helm chart `Chart.yaml` `name`, `chart/values.yaml` references
   - K8s `app.kubernetes.io/name` labels in `chart/templates/`
   - CRD group (`<name>.io/v1alpha1`) decision: keep `kagent.knuteson.io` group or migrate
   - Container image registry path
   - Argo `Application` names in `../new_localai/`
   - Documentation (`README.md`, `docs/*.md`)
6. CNCF landscape submission (post-public-release) under the new name.
7. Trademark filing decision (USPTO / EUIPO) — required reading: [techandmedialaw.com/ai-agent-trademark](https://techandmedialaw.com/ai-agent-trademark/).
8. Update `CLAUDE.md` § "Naming note" to reflect the chosen name + retire the placeholder.

None of step 4–8 is doable until step 1–3 is complete. Step 1–3 is a 1-2 hour task once the user picks a name.

---

## Sources

- Solo.io kagent repo: [github.com/kagent-dev/kagent](https://github.com/kagent-dev/kagent) — 2,689★, v0.9.2 (2026-05-07)
- Solo.io kagent release notes: [kagent.dev/docs/kagent/resources/release-notes](https://kagent.dev/docs/kagent/resources/release-notes)
- Solo.io blog — CNCF contribution: [solo.io/blog/bringing-agentic-ai-to-kubernetes-contributing-kagent-to-cncf](https://www.solo.io/blog/bringing-agentic-ai-to-kubernetes-contributing-kagent-to-cncf)
- Solo.io blog — agent mesh: [kagent.dev/blog/inside-kagent-oss-ent-ai-meshes](https://kagent.dev/blog/inside-kagent-oss-ent-ai-meshes)
- Red Hat Kagenti operator: [github.com/kagenti/kagenti-operator](https://github.com/kagenti/kagenti-operator)
- Red Hat Kagenti: [github.com/kagenti/kagenti](https://github.com/kagenti/kagenti)
- DataBassGit AgentForge (788★ GPL3): [github.com/DataBassGit/AgentForge](https://github.com/DataBassGit/AgentForge), [agentforge.net](https://agentforge.net/), [pypi.org/project/agentforge](https://pypi.org/project/agentforge/)
- Microsoft Agent-Forge: [github.com/microsoft/agent-forge](https://github.com/microsoft/agent-forge)
- frostlogic-ab Agent Forge: [github.com/frostlogic-ab/agent-forge](https://github.com/frostlogic-ab/agent-forge)
- AITech Agent Forge: [aitech.io/agent-forge/](https://aitech.io/agent-forge/)
- Kubefarm (aenix): [github.com/aenix-io/kubefarm](https://github.com/aenix-io/kubefarm), [aenix.io/kubefarm](https://aenix.io/kubefarm/)
- Kubefarm (wedos): [github.com/wedos/kubefarm](https://github.com/wedos/kubefarm)
- Kubefarm Kubernetes blog: [kubernetes.io/blog/2021/12/22/kubernetes-in-kubernetes-and-pxe-bootable-server-farm](https://kubernetes.io/blog/2021/12/22/kubernetes-in-kubernetes-and-pxe-bootable-server-farm/)
- KFARM Korea agriculture: [kfarm.co.kr/eng](https://kfarm.co.kr/eng/)
- K-FARM Klassen Group: [klassengrp.com/kfarm](https://klassengrp.com/kfarm/)
- AgentForge npm-package candidate site: [agentforge.dev](https://agentforge.dev)
- PodForge AI podcast service: [podforge.dev](https://podforge.dev)
- PodForge knifemaking: [podforge.com](https://podforge.com)
- AI Agent trademark race: [techandmedialaw.com/ai-agent-trademark](https://techandmedialaw.com/ai-agent-trademark/)
- USPTO trademark search: [uspto.gov/trademarks/search](https://www.uspto.gov/trademarks/search)
- audit-rev2 R1 §6.4 (urgency framing): `evidence/audit-rev2/R1.md`
- CLAUDE.md naming note: project root
