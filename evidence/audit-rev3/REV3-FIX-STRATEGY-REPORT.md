# rev3-fix-strategy — Final Report

**Date:** 2026-05-07
**Agent:** rev3-fix-strategy
**HEAD before:** `10c2a0c`
**HEAD after:** `cd9c7df` (5 atomic doc commits + 3 sibling code commits interleaved)
**Concurrency:** ran parallel with 3 sibling code-fix agents on disjoint scopes; used `git stash` + `git commit --only -F` per the brief.
**Scope:** 5 strategic doc edits surfaced by R1/R2 in rev3 audit.

---

## Deliverables — all 5 atomic doc commits landed and pushed to `origin/main`

| # | Commit | File | Source | Status |
|---|---|---|---|---|
| 1 | `d77f172` | `docs/WHY.md` | R1-WHY-§1.b | landed + pushed |
| 2 | `e077d8a` | `docs/RFC-CAPABILITY-NARROWING.md` | R1-RFC-§1.2 | landed + pushed |
| 3 | `0a3ebff` | `docs/CONTEXT-PRESSURE-PRIMITIVE.md` | R1-CONTEXT-§3 | landed + pushed |
| 4 | `02a873f` | `docs/A2A-IMPLEMENTATION-PLAN.md` | R2-A2A-§4 (S-A2A-OPTION-D) | landed + pushed |
| 5 | `cd9c7df` | `docs/PROTOCOLS.md` | R2-PROTOCOLS (S-RE-ORDER) | landed + pushed |

All 5 commits carry the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.

---

## What each commit changed

### 1. `d77f172` — `docs/WHY.md` §1.b qualifiers (R1-WHY-§1.b)

Replaced the §1.b sentence ending with "Macaroons are a 2014-era concept; nothing else in OSS K8s land ships caveat-narrowing JWT capabilities at the K8s spawn boundary today" with explicit OSS-vs-enterprise + narrowing-vs-OBO qualifiers per rev3 R1 §1.2:

- Added "no **OSS** K8s-native agent operator (excluding commercial enterprise distributions like Solo.io kagent enterprise's OBO) ships caveat-narrowing-on-spawn JWT capabilities — distinct from controller-minted identity-OBO JWTs."
- Cited `docs.solo.io/kagent-enterprise/docs/latest/security/obo/`.
- Cited `evidence/audit-rev3/R1.md §1.2` alongside the rev2 reference.
- Dropped the "Macaroons are a 2014-era concept" sentence as instructed (didn't add evidence).

### 2. `e077d8a` — `docs/RFC-CAPABILITY-NARROWING.md` §1.2 adjacent-but-not-equivalent (R1-RFC-§1.2)

Added a 6th bullet to the §1.2 "adjacent, not equivalent" catalogue covering Solo.io kagent enterprise OBO:

- Notes the wire-shape parity (RS256 + JWKS at well-known URL).
- Names the semantic distinction: OBO is identity-on-behalf-of, NOT `child.claims ⊆ parent.claims` enforcement.
- Frames both primitives as valuable in K8s-agent operator design — only kagent's enforces narrowing in OSS at the K8s admission boundary.
- Cited the docs.solo.io URL with verification date.

### 3. `0a3ebff` — `docs/CONTEXT-PRESSURE-PRIMITIVE.md` honest framing (R1-CONTEXT-§3)

Three updates per rev3 R1 §1.1:

- **§1 supporting argument reframed.** Replaced the framing ("every hosted agent platform we surveyed reaches for auto-compaction") with the rev3-honest framing: "every surveyed substrate that ships context-pressure primitives" — explicitly naming Anthropic Claude API (`compact-2026-01-12` beta), Microsoft Agent Framework 1.0 (`CompactionTrigger`/`TokenBudgetComposedStrategy`), Cloudflare Project Think, Anthropic Managed Memory, Google Vertex Memory Bank, and the Vercel `@context-chef/ai-sdk-middleware` — chose substrate-thick auto-compaction; **kagent is the only OSS substrate that bets the OPPOSITE way**.
- **§3 comparison table** expanded from 5 rows × 5 cols to 5 rows × 7 cols. Added MAF column (substrate-thick `CompactionTrigger`/`TokenBudgetComposedStrategy`/`Pipeline`/`Truncation`/`SlidingWindow`/`ToolResult`/`Summarization`, documented experimental). Added Vercel AI SDK community column. Updated the Anthropic Claude API row from "auto-compacts at ~95% hardcoded" to "operator-tunable under `compact-2026-01-12` beta — `trigger.value` ≥ 50,000, default 150,000 input tokens." Updated the Reading paragraph to match the rev3-honest framing.
- **Freshness commitment.** Added a "Last verified 2026-05-07; quarterly re-verification" note above the table, per rev3 R2 §5 recommendation #2.

### 4. `02a873f` — `docs/A2A-IMPLEMENTATION-PLAN.md` Option D (R2-A2A-§4)

Added a full §4.4 "Option D — In-pod A2A server (transparent-proxy / AgentCore pattern)" covering:

- Cross-vendor verification (AgentCore Runtime port-9000 transparent proxy; Vertex/ADK `ClientFactory` HTTP+JSON-RPC; Azure Foundry preview).
- Pros: speaks A2A natively (the marketing line AgentCore/Vertex/Azure use); no extra hop; `X-A2A-Extensions` pass through; `SendStreamingMessage` is straightforward; outbound symmetric; survives operator/bridge restart.
- Cons: requires HTTP server in agent-pod (changes pod design from one-shot Job); complicates pod boot path; ties A2A versioning to agent-pod release cadence; ~30-50MB memory cost; K8s primitive multiplication (Service+Ingress per Agent).
- Side-by-side trade-off matrix vs Option A.

Renamed §4.4 → §4.5 "Recommendation": flipped from rev2's "Option A (bridge)" to "Prefer Option D (native), with Option A as a staged fallback." Added staged-migration path: spike D in 1-2 days; if cost is acceptable, make D slate-1; if cost is high, ship A first to learn what's needed, then migrate. Added compat-as-feature limitation disclaimer for the staged-A path. Retained the bridge translation surface as §4.6 for reference if the spike rules D out.

### 5. `cd9c7df` — `docs/PROTOCOLS.md` slate flip (R2-PROTOCOLS / S-RE-ORDER)

Flipped slate 1 ↔ slate 5 per rev3 R2 §5.3:

- **Slate 1 = Capability narrowing RFC** (`v0.2.3-cap-rfc`). Rationale paragraph cites rev3 R2 §3.1 Path 4 (6-12 weeks SIG-Apps timeline) and rev3 R1 §1.2(i) (gap uncontested at SIG today). Names the "moat = 4-7 months" pressure-tested duration explicitly.
- **Slate 5 = A2A v1.0 wire** (`v0.2.7-a2a-wire`). Cross-references `docs/A2A-IMPLEMENTATION-PLAN.md` §4 for the Option A vs Option D architecture decision.
- Slates 2/3/4 unchanged in implementation; slate-3's "depends on slates 1 and 2" updated to "depends on slate 5 and slate 2" to match the new ordering.
- Updated the §9 "compat-as-a-feature framing" table to match the new slate numbers.
- Added an explicit "Slate ordering revised (rev3, 2026-05-07)" callout box before the slate list explaining the flip.

---

## Verification

- All 5 docs render as valid markdown (the prettier hook ran via lint-staged on each commit and succeeded; `pnpm -r typecheck` passed for all 5 commits).
- No code, chart, README, or evidence files touched by my agent.
- All 5 commits used `git commit --only -F <msg> <pathspec>` per the brief's concurrency discipline.
- Concurrent sibling work was handled by stashing non-doc working-tree changes before each commit and restoring after the push. Sibling commits (`b37d9cc`, `99f6171`, `915ee27`) interleaved with mine on `main` cleanly.
- Pre-commit hook ran with Node 22.22.0 (via `nvm use 22.22.0` in each commit shell session) per the brief.

## Commit log (final state)

```
cd9c7df docs(protocols): flip slate ordering — capability-narrowing RFC before A2A wire (R2)
915ee27 fix(operator): wire restarter.reset() from informer add/update handlers (C1-NEW-H1)
02a873f docs(a2a-impl): add Option D (in-pod A2A server) per AgentCore/Vertex transparent-proxy pattern (R2)
0a3ebff docs(context-pressure): honest framing — substrate-thick competitors named explicitly (R1)
99f6171 fix(agent-loop-vercel-ai): optional chaining + estimateTokens fallback for usage-less providers (C2R3-LOW-2, R3-LOW-1)
e077d8a docs(rfc): add adjacent-but-not-equivalent paragraph for Solo.io kagent-enterprise OBO (R1)
b37d9cc fix(agent-loop-vercel-ai): thread maxSteps to streamText stopWhen, add multi-step regression (R3-B1)
d77f172 docs(why): add OSS-vs-enterprise + narrowing-vs-OBO qualifiers to capability-narrowing claim (R1)
```

5 doc commits (mine) + 3 code commits (siblings) = 8 commits between `10c2a0c` and `cd9c7df`.

## Punchlist rows closed by this fix-strategy run

- `R1-WHY-§1.b` (MEDIUM/strategic) — `docs/WHY.md` qualifiers added.
- `R1-RFC-§1.2` (paired with R1-WHY-§1.b) — `docs/RFC-CAPABILITY-NARROWING.md` adjacent-but-not-equivalent paragraph added.
- `R1-CONTEXT-§3` (MEDIUM/strategic) — `docs/CONTEXT-PRESSURE-PRIMITIVE.md` table + framing updated.
- `R2-H1` / `S-A2A-OPTION-D` (HIGH/strategic) — `docs/A2A-IMPLEMENTATION-PLAN.md` Option D added; recommendation updated.
- `R2-MOAT` / `S-RE-ORDER` (MEDIUM/strategic) — `docs/PROTOCOLS.md` slate ordering flipped.

The remaining strategic punchlist items (`R2-H3` V0.1-rig backfill, `R2-MOAT` marketing-language updates beyond protocol slate ordering) are out of scope for this run per the brief.
