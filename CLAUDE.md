# CLAUDE.md

Guidance for Claude Code (and any AI assistant) working in this repository.

## What this repo is

`kagent` — the K3s-native, OSS, MIT-licensed agent farm operator. Composes Kata Containers + NATS JetStream + Bun + LiteLLM + Langfuse into the per-agent-microVM substrate that AWS AgentCore, Cloudflare Agents + Sandbox, and Anthropic Managed Agents all ship proprietarily.

This is the project that supersedes the "governance kernel" framing of `@ctkadvisors/agent-runtime`. That work was a learning experiment; the AgentExecutor implementation is being lifted into this repo as `@kagent/agent-loop`, a thin in-pod library. The Sempf / paperclip / authority-graph framing is retired.

**Status when this CLAUDE.md was written (2026-04-26):** spec committed; no code yet; v0.1 scope is the focus of the next implementation session.

## Sibling repos

```
../agent-runtime/         — learning experiment; AgentExecutor will be lifted into @kagent/agent-loop
../homelab-orchestrator/  — first consumer of the new substrate; its CronJob+runner will be retired
../new_localai/           — homelab K3s manifests; will reference kagent's k8s/ via an ArgoCD app manifest
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

## Conventions

- **TypeScript primary**, strict mode, ESM, Node 22 target
- **Runtime is currently Node 22 + tsx for both operator and agent-pod images.** Bun was the original target (Anthropic owns Bun as of Dec 2025; alignment intentional), but Bun 1.1's TLS handling rejects K3s's self-signed CA when `@kubernetes/client-node` opens its watch / status-patch paths — same kubeconfig works in Node, breaks in Bun. Reverting to Bun is on the v0.2 list once Bun fixes undici/TLS parity. See Dockerfile comments at `packages/operator/Dockerfile` and `packages/agent-pod/Dockerfile`.
- **MIT license header** on every `.ts` source file
- **Conventional commits** with co-author attribution per Chris's ctkadvisors style
- **No squash-on-merge** — keep history legible
- **Tests:** vitest or bun:test, co-located `*.test.ts`, ≥85% coverage on the operator reconciler, ≥75% on glue code

## Phase discipline

This repo uses **GSD** (the `.planning/` tree) for forward-looking planning. The migration from the prior lighter pattern (flat `docs/ROADMAP.md` checklist) happened on 2026-05-09 alongside the proto-society direction; legacy completed v0.1 phases remain in `docs/ROADMAP.md` as historical reference and are NOT duplicated in `.planning/`.

The current planning artifacts:

- [`.planning/PROJECT.md`](./.planning/PROJECT.md) — project bones, conventions, key decisions (D1–D5 are PROPOSED, not locked)
- [`.planning/REQUIREMENTS.md`](./.planning/REQUIREMENTS.md) — REQ-IDs with falsifiable acceptance criteria
- [`.planning/ROADMAP.md`](./.planning/ROADMAP.md) — phases + dependency graph (8 forward-looking v0.2 phases)
- [`.planning/STATE.md`](./.planning/STATE.md) — current phase pointer + blockers/concerns
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
