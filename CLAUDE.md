# CLAUDE.md

Guidance for Claude Code (and any AI assistant) working in this repository.

## What this repo is

`kagent` — the K3s-native, OSS, MIT-licensed agent farm operator. Composes Kata Containers + NATS JetStream + Node 22 + LiteLLM + Langfuse into the per-agent-microVM substrate that AWS AgentCore, Cloudflare Agents + Sandbox, and Anthropic Managed Agents all ship proprietarily.

This is the project that supersedes the "governance kernel" framing of `@ctkadvisors/agent-runtime`. That work was a learning experiment; the AgentExecutor implementation was lifted into this repo as `@kagent/agent-loop`, a thin in-pod library. The Sempf / paperclip / authority-graph framing is retired.

**Status (verified 2026-09-02):** shipped and running as the homelab fleet's substrate. 29 packages under `packages/` (`agent-loop-vercel-ai` removed), ~178k lines of source `.ts`, 353 test files, all passing on Node 22. Deployed via ArgoCD from `../new_localai/k8s-kustomized/overlays/production/kagent/`, where every component is pinned to **one tag** (`v0.2.46-loop-guards-rc.1` as of this writing). Four Agents run in production (`concierge` on Telegram, `operator-investigator`, `homelab-builder`, `brain-auditor`); the dsh staged pipeline (`improve-daily`, missions) opens PRs against this repo that `pr-reviewer` merges when trusted. Read `.planning/STATE.md` §"Reconciliation note (2026-09-02)" for what shipped in the 2026-08-30..09-02 burst and what is still open (operator `main.ts` size, shared http/k8s packages, code behind off-flags).

## Sibling repos

```
../agent-runtime/         — learning experiment; AgentExecutor will be lifted into @kagent/agent-loop
../homelab-orchestrator/  — first consumer of the new substrate; its CronJob+runner will be retired
../new_localai/           — homelab K3s manifests; pins kagent image tags in
                            k8s-kustomized/overlays/production/kagent/ (ArgoCD Applications)
../ai-interviewer/        — SeekArc; another consumer pattern, separate workload
```

## Reading order before any code

A fresh session must read these in order — the *why* and *what* are all here:

1. [`README.md`](./README.md)
2. [`docs/WHY.md`](./docs/WHY.md)
3. [`docs/DESIGN-V0.1.md`](./docs/DESIGN-V0.1.md)
4. [`docs/PRIOR-ART.md`](./docs/PRIOR-ART.md)
5. [`docs/HARNESS-LESSONS.md`](./docs/HARNESS-LESSONS.md)
6. [`docs/ROADMAP.md`](./docs/ROADMAP.md)
7. [`docs/PLATFORM-PRIORITIES.md`](./docs/PLATFORM-PRIORITIES.md)
8. [`docs/WORKBENCH.md`](./docs/WORKBENCH.md)

All eight exist (verified 2026-08-05). They describe the *why* and the v0.1 shape; they predate most of what has shipped since. For current state, read [`.planning/STATE.md`](./.planning/STATE.md) next, then the two documents that are binding rather than descriptive: [`docs/NORTH-STAR-SYSTEM-DESIGN.md`](./docs/NORTH-STAR-SYSTEM-DESIGN.md) (source of the §11 / §15 gates) and [`docs/COMMAND-CENTER-CONTRACT.md`](./docs/COMMAND-CENTER-CONTRACT.md) (binding for any Workbench/Command Center work). Designs for post-v0.1 subsystems live in [`docs/superpowers/specs/`](./docs/superpowers/specs/).

## Conventions

- **TypeScript primary**, strict mode, ESM, Node 22 target
- **Runtime is Node 22.** `tsx` is dev-only: both the operator and agent-pod images build on `node:22-alpine`, compile TS to JS in a build stage, and the runtime stage runs `node dist/main.js` with no loader and no devDeps. Bun was the original target (Anthropic owns Bun as of Dec 2025; alignment intentional), but Bun 1.1's TLS handling rejects K3s's self-signed CA when `@kubernetes/client-node` opens its watch / status-patch paths — same kubeconfig works in Node, breaks in Bun. Re-evaluating Bun is deferred to v0.3+ once Bun fixes undici/TLS parity. See Dockerfile comments at `packages/operator/Dockerfile` and `packages/agent-pod/Dockerfile`.
- **MIT license header** on every `.ts` source file
- **Conventional commits** with co-author attribution per Chris's ctkadvisors style
- **No squash-on-merge** — keep history legible
- **Tests:** vitest, co-located `*.test.ts`. CI runs `pnpm -r test` and does **not** run coverage at all. The "≥85% on the operator reconciler, ≥75% on glue code" targets carried in `.planning/PROJECT.md` are aspirational, not enforced: of 29 `vitest.config.ts` files, 27 declare a `thresholds` block, but only `operator`, `agent-pod`, and `agent-loop-vercel-ai` set real numbers (lines/functions/statements 80, branches 70) — the other 24 are set to `0`, and `cli` / `workbench-ui` declare none. Treat the targets as intent; if you want them enforced, wire `test:coverage` into `.github/workflows/ci.yml` first.

## Phase discipline

This repo uses **GSD** (the `.planning/` tree) for forward-looking planning. The migration from the prior lighter pattern (flat `docs/ROADMAP.md` checklist) happened on 2026-05-09 alongside the proto-society direction; legacy completed v0.1 phases remain in `docs/ROADMAP.md` as historical reference and are NOT duplicated in `.planning/`.

The current planning artifacts:

- [`.planning/PROJECT.md`](./.planning/PROJECT.md) — project bones, conventions, key decisions (D1–D7 are PROPOSED, not locked)
- [`.planning/REQUIREMENTS.md`](./.planning/REQUIREMENTS.md) — REQ-IDs with falsifiable acceptance criteria
- [`.planning/ROADMAP.md`](./.planning/ROADMAP.md) — phases + dependency graph (5 forward-looking v0.2 phases, plus a 999.x future-research backlog)
- [`.planning/STATE.md`](./.planning/STATE.md) — current phase pointer + blockers/concerns

**Phase discipline lapsed after 2026-05-10.** Phases 1–4 completed under GSD; Phase 5 was planned and never executed. Everything from 2026-06-04 onward (Studio Architect, Mission Control redesign, the local AgentCore tool-runtime plane, the channel control plane, the shell/SSH tool runtime) shipped outside the phase machinery, tagged `v0.2.x-<name>-rc.N` instead of `vX.Y.Z-phaseN`. `.planning/STATE.md` records what landed. Before opening a new phase, decide whether to back-fill that work as phases or close v0.2 and open a v0.3 roadmap around it.
- [`.planning/intel/`](./.planning/intel/) — synthesized planning context from ingested design docs (`NORTH-STAR-SYSTEM-DESIGN.md` + `PROTO-SOCIETY-DESIGN.md`)

Drive phase work with `/gsd-*` slash commands:

- `/gsd-progress` — answer "where am I?"
- `/gsd-plan-phase N` — produce `PLAN.md` for a phase (after a discuss step)
- `/gsd-execute-phase N` — execute the plan with atomic commits
- `/gsd-resume-work` — pick up mid-phase after a context reset

Don't invent unscoped work. Every phase must answer the §11 bounds test (declared capability + bounded resource drain + observable state transition + auditable output + revocation path) and the §15 one-sentence test from `docs/NORTH-STAR-SYSTEM-DESIGN.md`.

When a phase completes:
1. Each task commit is atomic (Conventional Commits: `feat(phase-N-...)`, `fix(phase-N-...)`, etc.) — `/gsd-execute-phase` enforces this
2. STATE.md and ROADMAP.md checkbox updates happen as part of phase verification
3. Tag `vX.Y.Z-phaseN`
4. Push branch + tag (auto-pushed by default per memory)

## What this repo does NOT do

- ❌ Implement an agent SDK — agents in pods run any framework (Strands TS, Mastra, forked AgentExecutor)
- ❌ Implement an LLM gateway — uses LiteLLM Proxy, Helm-deployed
- ❌ Implement a trace store — uses Langfuse self-hosted, Helm-deployed
- ❌ Implement a Kubernetes-management agent (this is `kagent.dev`'s domain) — NAMING NOTE BELOW
- ❌ Track cluster manifests — `new_localai` does that
- ❌ Build a workflow / DAG / Swarm engine — A2A is messaging-primitive level only; topology is application-layer

## Naming note

`kagent` (this project) is named after Knuteson + agent. There is an unrelated project at [kagent.dev](https://kagent.dev) (Solo.io) for K8s-operating-agents — different problem domain (autonomous K8s ops), different audience. Pre-public-release we will evaluate rename to avoid collision: candidates include `agentforge`, `kfarm`, `agentpod`, `podforge`. For now, internal/local use of `kagent` is fine.

## When in doubt about scope

This repo has ONE job: ship the K3s-native substrate (operator + CRDs + agent pod runtime + A2A bus + observability + model gateway integration) so that any agent workload can run with per-agent isolation, A2A messaging, and unified observability — on the homelab K3s today, and on any cloud K8s tomorrow. Everything else is application-layer.

If a feature would expand the substrate's primitives appropriately (e.g., add `RuntimeClass: kata` support, add JetStream cluster mode, add a custom controller pattern for an existing operator concept), it belongs here. If a feature would expand the agent application surface (new tools, new prompts, new domain logic), it belongs in a CONSUMER repo (initially `homelab-orchestrator`).

## Operational context (homelab)

- **K3s cluster:** managed by `new_localai/`. ArgoCD is the GitOps engine.
- **LLM endpoint (default):** Cloudflare AI Gateway (`workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct` and others; provider prefix REQUIRED). Jetson1 Ollama is opt-in only, accessed at bare-metal IP `192.168.68.73:11434`.
- **Image-gen endpoint (opt-in):** ComfyUI on `Mini-2.local:8188` (`http://192.168.68.60:8188`) — Apple M4 / 16GB / MPS, launchd-managed (`io.knuteson.comfyui`). Native install at `~/comfyui/` on mini-2. Default checkpoints: `sd_xl_turbo_1.0_fp16.safetensors`, `v1-5-pruned-emaonly.safetensors`. Workflow: POST `/prompt`, poll `/history/<id>`, fetch `/view?filename=...`. ComfyUI also installed on jetson1 (`dustynv/comfyui:r36.4.0` Docker, stopped) but Orin Nano 8GB unified RAM hits Tegra NvMap OOM on SD-class diffusion — kept as backup only for FLUX-schnell-GGUF Q4 experimentation. **For asset generation: read [`docs/IMAGE-ASSETS.md`](./docs/IMAGE-ASSETS.md) first** — there is **no active visual lock** for the workbench (the 2026-05-08 sprite-GUI experiment was abandoned); the pipeline still works for one-off uses (README hero, marketing). Don't skin the workbench in any visual style — game-like character lives in usability primitives, not chrome.
- **GitOps only on the homelab cluster** — never reach for imperative `kubectl apply/exec/port-forward`. Deploy AND verify via git → Argo. Ship verification as Job manifests.
- **Don't auto-merge PRs** — `gh pr create` and `gh pr merge` are not a unit; per-PR explicit consent only.
- **Check existing hostnames** before grabbing a `*.knuteson.io` subdomain — `kubectl get ingress,ingressroute -A` + grep `new_localai/`, BEFORE writing any Ingress.
