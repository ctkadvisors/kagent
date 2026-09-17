# Colony realignment: put the fleet back on the substrate

**Date:** 2026-09-16
**Status:** proposed; needs operator acceptance (it promotes 999.x items and opens v0.3)
**Audience:** Chris; any agent or session about to change the fleet
**Binding inputs:** [`NORTH-STAR-SYSTEM-DESIGN.md`](../../NORTH-STAR-SYSTEM-DESIGN.md),
[`PROTO-SOCIETY-DESIGN.md`](../../PROTO-SOCIETY-DESIGN.md),
[`HYBRID-AGENT-POLICY.md`](../../HYBRID-AGENT-POLICY.md), [`WHY.md`](../../WHY.md),
[`COMMAND-CENTER-CONTRACT.md`](../../COMMAND-CENTER-CONTRACT.md), `.planning/` (D1–D7, §11, §15)

This is not a new design. The design exists and is good. This document records how far the
running fleet has drifted from it, and the order in which to bring it back.

## 1. What the design asks for

- A **colony**: many specialized agents collaborating through substrate objects (north star §2, §5);
  "you, but more you's collaborating and learning" (proto-society, the ambition).
- One loop: `Intent -> Work -> Evidence -> Review -> Promotion -> Better Future Work` (§3).
- **Growth is promotion.** Repeated work becomes a versioned, scoped, revocable catalog object:
  prompt, AgentTemplate, verifier, workflow, tool, capability policy, in rising authority risk (§6).
  Agents are session-scoped; the society persists through what it promotes. Consolidation is its sleep.
- **Signals propose; governance disposes** (D3). Self-proposal, never self-promotion (D6).
  Culture (prompts, templates) may be approved by policy; power (tools, capability, egress) stays
  human-gated (proto-society, governance table).
- Any channel creates the same work order and the same evidence trail (§10). The operator throws
  ad-hoc work in through chat, CLI, webhook or schedule, and steers only when blocked.
- §14: no hidden self-modifying production code, no UI-only world state, no CRD before repeated
  behavior proves it.

## 2. What runs today (verified 2026-09-16)

In the substrate: Phases 1–4 shipped. AgentDisposition overlay with cap-JWT narrowing and
`/api/dispositions`; Command Center; flow overlays; review queue and AgentTemplate promotion end to
end (`workbench-api/src/routes/review-queue.ts`); `AgentTask.spec.verifyContract` with a
deterministic `scriptRef` mode; spawnChild, templates, triggers, channels, tool runtime.

In production: `audit` is off because **NATS is not deployed** (0 NATS pods in the cluster), so the
A2A bus and the audit trail have never run here. `verifier` is off (no script-runner image was
cut; the LLM-judge path pointed at Cloudflare). `artifactStorage` is off. No disposition
overlay exists in the cluster (the Phase 1 demo ConfigMaps are gone), so no agent has idle behavior. Five Agent CRs; twenty draft templates untouched
for 100 days. Evidence, Review and Promotion, the half of the loop that makes the colony grow, is
switched off.

Beside the substrate: `new_localai/services/fleet-scripts`, about 7,000 lines of Python written
2026-08-30 to 09-16, mostly by Claude steward sessions (126 merged PRs in the last week against 3
from the fleet). It rebuilt each designed organ as a private copy:

| Designed organ | Shadow in fleet-scripts |
|---|---|
| Work order: `AgentTask` / `AgentWorkflow` on an `Agent` | raw K8s Jobs running dsh (`launcher.py`, `stage.sh`, `mission.yaml`) |
| Evidence: task status, artifacts, audit events, traces | an 11-table Postgres ledger (run, candidate, outcome, verdict, idea, lesson, post, link, decision, anomaly, scheduler) |
| Review: `verifyContract` + review queue; reviewers by authority | `review.py`: a qwen38 confidence >= 85 merges, two rounds close |
| Idle behavior: AgentDisposition (budget, proposal scope) | `reconcile.py` idle ladder, 2,316 lines, knobs in env |
| Discourse: Post / Channel (999.2) | forum posts in the ledger, `relay_questions` |
| Consolidation controller (999.3) | dream Job, `memory.py` lessons |
| Catalog + promotion (§6, REV-02) | idea archive with lineage; "growth" is a PR against its own harness |
| Learning signals (§7.3), external eval | `metrics.py`, bench, observed outcomes |
| Human map: Workbench / Command Center (D7) | `console.py`, a second UI |

Two consequences explain the last two weeks. **A signal is acting as governance:** an LLM's
confidence score disposes, against D3, and as of 2026-09-15 no fleet PR had scored 85 (max 82), so the loop stalls at
Review and a human (or Claude) patches the gate. **Growth is aimed at the wrong target:** the fleet
improves by editing its own production code, the thing §14 rules out, instead of promoting
capability. 39 fleet PRs since 09-09, 7 merged.

The two weeks were not wasted. They are the "repeated behavior" D2 asks for before a concept earns
a place in the substrate: discourse, consolidation, idle dispositions, claims and observed outcomes
all proved they are needed. The mistake was building them outside.

## 3. Decisions requested

- **D8 (proposed).** kagent is the substrate. No replacement runtime. fleet-scripts is a consumer:
  it may hold prompts, stage scripts and metrics code; it may not hold a parallel ledger, reviewer,
  forum, scheduler or UI.
- **D9 (proposed).** An LLM judgment is a Review *signal*. Disposal is policy (a deterministic
  verifier: tests, `verify.sh`, bench, replay/eval, scope rules) for low and medium authority, and
  human for tool, capability and egress changes. Observed outcomes with revert is the revocation
  path for what policy approved.
- **D10 (proposed).** The colony grows through the catalog. A change to substrate or harness code is
  ordinary work (a work order ending in a visible PR), never the growth mechanism.
- Close v0.2 (Phase 5 stays unexecuted, recorded as such) and open **v0.3 "colony"** below. Promote
  999.2 (Post as artifact), 999.3 (consolidation, read-only) and 999.8 (pilot) to candidate
  requirements, on the evidence in §2.

## 4. v0.3 phases

Each phase ends observed live for at least 24 h before the next starts. The fleet keeps running
as it is until a phase replaces one of its organs; nothing is deleted before its replacement is
observed working. Each phase answers §11 and §15 in its plan.

**Phase 1 — Turn the designed loop on.** Deploy NATS JetStream (WHY §3.4), enable `audit`,
`artifactStorage`, and `verifier` in `scriptRef` mode with a runner image; keep the LLM-judge path
pointed at the spark's qwen38 and advisory.
*Observed:* an `AgentTask` with a `verifyContract` completes with `status.verification`,
`status.artifacts` and audit events, and a failed verify appears in `#/review`.
*Unknown to resolve first:* how much of the flag-gated code (about 11k lines) works in production;
budget the phase for that discovery.

**Phase 2 — Missions are work orders.** A mission becomes an `AgentTask` on a `coder` Agent whose
work is the existing staged pipeline; `verify.sh` becomes its `verifyContract.scriptRef`; stage
output becomes artifacts. The Agent CRD has no image field today, so the plan starts by choosing
between a tool-runtime session that runs the pipeline and a pod-template extension (the design
allows any framework in the pod, CLAUDE.md "does NOT do"). The launcher shrinks to "create an
AgentTask". *Observed:* one fleet mission end to end as an AgentTask, visible in the Workbench
with trace, artifacts and verification; ledger `run` rows become a projection of task status.

**Phase 3 — Seed the colony.** Standing Agents from versioned templates, each with a real
disposition (attention budget, read channels, proposal scope): concierge (front door, exists),
scout/ideator, coder, reviewer (qwen38), investigator (exists), curator, ops (homelab-builder,
exists). Budgets come from the flow economy the spark actually has (8 ornith15 streams, 2 qwen38
slots). `reconcile.py`'s idle ladder is replaced by dispositions plus `KagentSchedule`/triggers.
Ad-hoc work from Telegram becomes a root task the concierge may split with `spawnChild`.
*Observed:* two or more agents working concurrently from one ad-hoc request; every token spent
idle attributed to a disposition in `/api/dispositions`.

**Phase 4 — Promotion for culture.** Lessons, prompt changes, skills and specialist roles become
candidate artifacts in the existing review queue. Policy approval = the candidate's verifier
(bench or replay/eval delta, size and scope rules) passes and a second agent's review signal is
recorded; no self-review. Accepted candidates become versioned catalog objects future tasks load.
Tools, capability and egress stay human-reviewed. *Observed:* one capability promoted by the
colony without a human, then used by a later task, then its effect measured by the metric catalog;
one candidate rejected with its reason kept.

**Phase 5 — Discourse and sleep.** Forum posts become `Post` artifacts with citations (999.2; the
name must not collide with the shipped chat `Channel` CRD). The dream Job becomes the read-only
consolidation controller (999.3): it reads closed task trees, posts and outcomes and files
proposals into the same queue. Decay follows: a catalog object unused or regressing files its own
re-review. *Observed:* a consolidation proposal promoted through Phase 4's path.

**Phase 6 — Retire the shadows.** Delete `review.py`'s rounds and merge bar, the ledger tables the
substrate now covers, the forum, `console.py` (Workbench is the map, D7), and the reconcile code
dispositions replaced. What remains in fleet-scripts: stage prompts and scripts, the metric
catalog, the bench. Quarantine and the human-only kill switch (999.6, 999.7) land before any
coalition work.

Not in v0.3: CoalitionProposal, reputation, voting, behavior-tree policy (HYBRID-AGENT-POLICY stays
a seed), the `main.ts` split. Each waits for its own evidence.

## 5. Until Phase 2 lands: two rule changes to the running fleet

So the fleet stops stalling while the substrate work happens. Both are deletions.

1. `review.py`: the merge decision is CI green + `verify.sh` green + scope rules (diff size, no
   deleted tests, path allowlist), with observed outcomes as the revert path. The qwen38 review is
   posted as a comment and feeds the next idea. Remove rounds, the 85/70 bars, close-after-two.
2. Freeze: no steward PR to fleet-scripts in response to a single failure. Defects found become
   work orders for the fleet. Exceptions: canaries red, or no runs for 6 h.

## 6. How Claude works on this

- Read the binding inputs above before proposing anything. Search both repos before recommending
  a tool (Hermes Agent ran here 2026-04-18 to 09-03 and was recommended again on 09-16 unread).
- Substrate work goes through `.planning/` phases with §11/§15 answers. One phase at a time.
- Every fleet change names the design section it serves and the substrate object it uses. A change
  that adds a parallel ledger, reviewer, forum, scheduler or UI is rejected on sight.
- Report, in this order: capabilities promoted by the colony, fleet work orders completed without a
  human, human interventions, halts. Deploys are not outcomes.

## 7. Supersedes on acceptance

In `new_localai/docs/superpowers/specs/`: the review and round rules in
`2026-09-04-self-driving-fleet-design-v2.md`; the storage and review sections of
`2026-09-08-fleet-memory-mentor.md` and `2026-09-10-idea-lineage.md` (lineage becomes catalog
provenance); `2026-09-16-observed-outcomes-design.md` keeps its principles and metric catalog, and
its ledger tables move onto task status, audit events and artifacts in Phase 2–4.
