---
gsd_state_version: 1.0
milestone: v0.2
milestone_name: milestone
status: executing
stopped_at: Phase 05 planned but never executed; work continued outside GSD
last_updated: '2026-08-05T00:00:00.000Z'
last_activity: 2026-07-08 -- shell.exec SSH runtime + qwen tool-call parsing fixes (outside GSD)
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 20
  completed_plans: 17
  percent: 85
---

# Project State

## Project Reference

See: .planning/PROJECT.md (re-steered 2026-05-09 PM)

**Core value:** The substrate turns intent into verified reusable capability under bounded resources, observable state, and revocable authority. **Signals propose; governance disposes.** Agents propose; substrate or human governance promotes; no agent self-escalates authority.
**Current focus:** Phase 05 — workbench-usability-primitives (planned 2026-05-10, never executed)

## Current Position

Phase: 05 (workbench-usability-primitives) — PLANNED, NOT STARTED
Plan: 0 of 3 complete (05-01/02/03 plans written 2026-05-10; no execution commits)
Status: Stalled inside GSD; substantial work shipped outside it (see below)
Last activity: 2026-07-08 -- shell.exec SSH runtime + qwen tool-call parsing fixes (outside GSD)

Progress: [████████░░] 80% (4 of 5 phases)

### Reconciliation note (2026-08-05)

This file drifted from 2026-05-11 to 2026-08-05. In that window 67 commits landed (2026-06-04 through 2026-07-08) and **none of them ran through `/gsd-execute-phase`** — `.planning/` was untouched except for one `prettier --write` pass (`530251b`). Phase 05 is still 0/3; the `progress` block above is unchanged and remains correct for GSD-tracked work only. It materially understates what the repo now contains.

Verified repo scale as of 2026-08-05 (HEAD `916576f`):

- 30 packages under `packages/`
- 168,024 tracked lines of `.ts` / `.tsx`
- 4,045 vitest cases across 247 test files, all passing under Node 22 (`pnpm -r test`, 0 failures)

**Idle roughly four weeks.** Last commit is 2026-07-08; today is 2026-08-05.

### Shipped outside GSD phase discipline (2026-06-04 → 2026-07-08)

Five coherent themes, each cut as `v0.2.x-<name>-rc.N` image tags rather than `vX.Y.Z-phaseN` tags. None of this is represented in `ROADMAP.md`.

1. **kagent Studio Architect + Mission Control UI** (2026-06-04 → 06-05) — chat-to-create spine in `workbench-api` (`36983c1`); `workbench-ui` Mission Control enterprise redesign (`1cb6f74`). Tags `v0.2.0-studio-rc.1..3`, `v0.2.1-mission-control-rc.1`.
2. **Architect + gateway + agent-pod hardening** (2026-06-07 → 06-08) — architect drafts launch as tasks and route model classes; agent-pod gates substrate tools by agent intent and tolerates k8s JSON-patch 422; operator splits template server from health port; gateway stops stale model dispatch loops; agent execution made killable. Tags `v0.2.5..v0.2.14-killable-solid-rc.1`.
3. **Local AgentCore tool-runtime plane** (2026-06-08 → 06-10) — new `packages/tool-gateway`: isolated session manager, per-task code-runner isolation, Steel adapter, Playwright CDP browser driver, runtime invoke HTTP handler, gateway-owned tool profiles, typed session profiles; `packages/dto` tool-runtime session contracts; operator forwards the tool-gateway URL to agent pods; Helm deployments for the local runtime; CI publishes the tool-gateway image. Designs live in `docs/superpowers/specs/2026-06-08-local-agentcore-runtime-design.md`. Tags `v0.2.15..v0.2.20`.
4. **Channel control plane** (2026-06-12 → 06-16) — `Channel` / `ChannelBinding` / `ChannelSession` CRDs (`packages/operator/manifests/crds/channel*.yaml`) plus a channel gateway controller; `packages/channel-whatsapp-adapter` and `packages/channel-telegram-adapter`; workbench channel control surface and pairing-QR render; outbound reply delivery; denied-inbound attempts surfaced; idempotency self-replay fix. Tags `v0.2.21..v0.2.29`.
5. **Shell tool runtime + qwen tool-call parsing** (2026-07-04 → 07-08) — `shell.exec` tool kind in `packages/dto`, dispatched over SSH via `packages/tool-gateway/src/shell-runner.ts` (`SshShellRunner`, restricted to elitemini2/jetson2), operator-chart `toolRuntime.shell` SSH key/env passthrough, ssh client in the runtime image, known_hosts written to `/tmp` for the read-only gateway pod; four `openai-compat` fixes recovering leaked qwen tool names/arguments (`</tool_call>` tags, `<parameter=...>` tags, inline args, inline JSON args). Tags `v0.2.30..v0.2.37`.

**Tag-series note.** The `v0.3.0-capabilities` through `v0.5.4-keyrotation` semantic tags all point at commits dated **2026-05-04** — they are v0.1-era Wave work (capabilities, supervision, workflows, events, blackboard, cache, identity, locality, tenancy, egress, quotas, versioning, keyrotation), already recorded in `PROJECT.md` "Validated" and `docs/WAVES.md`. They are not post-2026-05-11 work.

### Reconciliation note (2026-09-02)

Repo woke up. Between 2026-08-30 and 2026-09-02 the homelab fleet became the
consumer this substrate was built for, and the fleet's failures drove the code:

- **v0.2.43-external-mcp-prefix** — tool-gateway namespaces external MCP tools as
  `mcp.*`; providers JSON from a Secret (`externalProvidersSecretRef`). The graphiti
  brain is reachable by agents through it.
- **v0.2.44-gateway-body-cap** (PR #8) — llm-gateway `MAX_BODY_BYTES` 64 KiB → 8 MiB
  with a JSON 413. The old cap destroyed the socket at ~16k tokens of conversation and
  accounted for 33 of the 61 AgentTask failures ever recorded. openai-compat surfaces
  undici's `cause`; agent-loop retries status-0 transport failures.
- **v0.2.45-telegram-brain** (PR #9) — the Telegram adapter writes one graphiti
  episode per exchange at delivery and bridges the previous exchange into the next
  message (`brain.ts`). Chart: `channels.telegram.brain.*`.
- **v0.2.46-loop-guards** (PR #10) — agent-loop `toolGuards` (identical call ≤ 2,
  per-tool ≤ 8, tool result capped at 16k chars, middle-elided); http-tool-provider
  GET sends no body; `agent-loop-vercel-ai` deleted (1,545 lines, no dependents).
- Two autonomous PRs merged from the dsh staged pipeline (#4, #7).

Production is being brought to **one tag** (v0.2.46) across operator, agent-pod,
tool-gateway, both adapters, llm-gateway and workbench; the charts rendered
byte-identical against production values from the old tags, so the jump is images
only. `contextWindowTokens: 262144` is now set on every model class in production,
which makes the context-awareness slate live for the first time.

Known, not done: `operator/main.ts` is 4,523 lines with a 2,632-line `main()`; six
hand-rolled HTTP servers and nine k8s wrappers (`@kagent/http`, `@kagent/k8s`
proposed); ~11k lines sit behind flags that are off in production (verifier,
workflows, workspaces, egress, quota, versioning, events, blackboard); `console.*`
is the logger. Fleet-side design notes live in
`../new_localai/docs/superpowers/specs/2026-09-02-telegram-concierge-design.md`.

### Deployed on the homelab (image tags pinned in `../new_localai`)

Read from `k8s-kustomized/overlays/production/kagent/*.yaml`:

- operator — `v0.2.33-shell-ssh-runtime-rc.1`
- agent-pod — `v0.2.36-qwen-inline-json-args-rc.1`
- tool-gateway — `v0.2.37-shell-known-hosts-rc.1`
- workbench (api + ui) — `v0.2.27-channel-denied-inbound-rc.1`
- llm-gateway — `v0.2.14-killable-solid-rc.1`
- channel-whatsapp-adapter — `v0.2.27-channel-denied-inbound-rc.1`
- channel-telegram-adapter — `v0.2.29-channel-telegram-rc.2`

## Performance Metrics

**Velocity:**

- Total plans completed: 17
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| —     | —     | —     | —        |
| 01    | 4     | -     | -        |
| 02    | 4     | -     | -        |
| 03    | 3     | -     | -        |
| 04    | 6     | -     | -        |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

_Updated after each plan completion_

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md "Key Decisions" table. **All D1–D7 are PROPOSED, not locked ADRs.** Promoting any to ADR status requires explicit user input.

Recent decisions affecting current work:

- **2026-05-09 PM (re-steering):** Re-output the entire planning corpus per operator directive. Treat `docs/NORTH-STAR-SYSTEM-DESIGN.md` and `docs/PROTO-SOCIETY-DESIGN.md` as candidate inputs only. Demote proto-society primitives (CRD-shaped Channels/Posts/CoalitionProposals/reputation/society kill-switch) to Future Research. Reframe AgentDisposition as overlay-first prototype on existing v0.1 substrate. Add D6 (self-proposal, not self-promotion) and D7 (`docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work). Rename "MobProposal" → "CoalitionProposal" in synthesized outputs. Move original Phases 2–8 (CRD-first proto-society) to Future Research backlog 999.x.
- **2026-05-09 (initial intel + roadmap):** adopted the §11 bounds test and §15 one-sentence test as per-phase verification gates (still binding). Original roadmap created from intel ingest; superseded by 2026-05-09 PM re-steering above.

### Pending Todos

None yet. (Capture via `/gsd-add-todo` during execution.)

### Blockers/Concerns

- **GSD tracking and the repo have diverged (recorded 2026-08-05).** Everything from 2026-06-04 onward shipped outside the phase machinery: no `docs(phase-NN-...)` commits, no `.planning/phases/06+` directories, no `vX.Y.Z-phaseN` tags. Before `/gsd-plan-phase` is used again, decide whether the tool-gateway / channel-control / shell-runtime work gets back-filled as phases or whether the v0.2 roadmap is closed out and a v0.3 roadmap is opened around what actually shipped. Phase 05's three plans are still on disk and unexecuted.
- **New CRDs shipped against D2.** D2 ("defer CRDs until repeated behavior justifies one") named `Channel` as something not to build in v0.2, and `ROADMAP.md` Notes say "No new CRDs in v0.2." `Channel`, `ChannelBinding`, and `ChannelSession` CRDs shipped anyway on 2026-06-12. Either D2 was overridden deliberately (in which case record the override) or the roadmap note is now false. Also note `AgentDisposition`'s ~7-day post-Phase-1 observation window (opened 2026-05-09) closed long ago with no promotion decision filed.
- **Four weeks idle.** HEAD `916576f` is 2026-07-08; today is 2026-08-05. Nothing is mid-flight in the working tree, but the deployed cluster is running images built from that HEAD.

- **`HYBRID-AGENT-POLICY.md` not yet ingested.** Both north stars cross-reference it. The current active scope (overlay-first AgentDisposition; Command Center hardening; flow overlays; review-queue projection; usability primitives) does NOT depend on per-agent reactive+deliberative policy details, so this is informational rather than blocking. If a future-research phase activates and needs it, run `/gsd-ingest-docs` first.
- **D1–D7 are proposed, not locked.** No ADRs were ingested. Promoting any of D1–D7 to formal ADR status requires explicit user input before phases that depend on those locks.
- **Original CRD-first proto-society roadmap demoted.** The original Phases 1–8 (CRD-first AgentDisposition, Discourse, Consolidation, MobProposal, Decay, Quarantine, Revoke, Pilot) are recorded in `intel/requirements.md` as candidate inputs and in `ROADMAP.md` Future Research backlog (999.x). Do not plan from those.

## Deferred Items

### Carried from v0.1 close (per `docs/ROADMAP.md` and intel):

| Category  | Item                                                                       | Status                                | Deferred At |
| --------- | -------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| Runtime   | Bun runtime re-evaluation (currently Node 22 + tsx)                        | Deferred to v0.3+                     | v0.1        |
| Isolation | Whether agent-sandbox replaces Kata Containers as isolation backend        | Long-term decision per NORTH-STAR §13 | v0.1        |
| CRDs      | Whether `Tool`, `SteeringEvent`, `TaskReview` graduate to first-class CRDs | Defer per `D2` until usage justifies  | v0.1        |

### Carried from 2026-05-09 PM re-steering (proto-society Future Research):

| Category    | Item                                                                                                       | Status                                                                               | Deferred At      |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------- |
| CRDs        | `AgentDisposition` as a first-class CRD (vs the v0.2 overlay prototype)                                    | Future Research; promote post-Phase 1 if observation justifies                       | v0.2 re-steering |
| Discourse   | `Channel` / `Post` as artifacts and later CRDs                                                             | Future Research; defer until read-side proves out                                    | v0.2 re-steering |
| Coalition   | `CoalitionProposal` (renamed from "MobProposal") with signed quorum, no-self-review, ring-review detection | Future Research; defer until coalition action is real                                | v0.2 re-steering |
| Controllers | Consolidation controller (read-only daemon proposing hygiene actions)                                      | Future Research; defer until manual review-queue ergonomics prove what hygiene means | v0.2 re-steering |
| NFR         | Decay / revalidation policy on catalog object kinds                                                        | Future Research                                                                      | v0.2 re-steering |
| NFR         | Quarantine semantics as first-class state                                                                  | Future Research                                                                      | v0.2 re-steering |
| Governance  | Substrate-level proto-society revocation kill-switch                                                       | Future Research; non-negotiable IF the layer ships                                   | v0.2 re-steering |
| Pilot       | Pilot deployment of proto-society layer (1–2 agents, observe)                                              | Future Research; only after primitives exist                                         | v0.2 re-steering |
| Reputation  | Specific reputation algorithm                                                                              | Future Research; pick after pilot signal                                             | v0.2 re-steering |
| Voting      | Specific voting rule for CoalitionProposal                                                                 | Future Research; pick after coalitions are real                                      | v0.2 re-steering |

## Session Continuity

Last GSD session: 2026-05-11T01:15:19.142Z
Last repo commit: 2026-07-08 (`916576f`) — outside GSD
Reconciled: 2026-08-05 (this file re-synced to git after ~3 months of drift)
Stopped at: Phase 05 planned but never executed
Re-steered: 2026-05-09 PM during /gsd-plan-phase 1 — operator redirected the entire planning corpus.
Resume file: .planning/phases/05-workbench-usability-primitives/05-01-PLAN.md (plans already written)
Next action: **decide before resuming** — either close out v0.2 and open a v0.3 roadmap around the tool-gateway / channel-control / shell-runtime work that actually shipped, or execute the existing Phase 05 plans as written (`/gsd-execute-phase 05`, WB-01/02/03). Re-read the Phase 05 plans against current `workbench-ui` first; they were written before the Mission Control redesign (`1cb6f74`) and may reference components that no longer exist.
