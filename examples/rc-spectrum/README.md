# `examples/rc-spectrum/` — v0.1.9 RC1 spectrum bundle

**Date:** 2026-05-07
**Companion to:** `examples/rc-pilot/` (the GA-evidence-driven scenario set).

This bundle exercises the substrate against a **wider task spectrum**
than rc-pilot — researcher, code-generator, long-running multi-step
orchestration, head-to-head model comparison — and against **two
distinct CF AI Gateway models** so the substrate's "swap models with
no Agent CR change" claim is observable end-to-end.

## What runs

| File | Scenario | Agent | Model | Shape |
| --- | --- | --- | --- | --- |
| `10-research-deep.yaml` | Deep researcher | `rc-spectrum-researcher` | llama-3.3-70b | single-shot, long output (~1.5K tokens) |
| `20-code-generator.yaml` | Code generator | `rc-spectrum-code-writer` | llama-4-scout | tool-using (`write_artifact`), 2K-token Helm chart |
| `30-long-running.yaml` | 4-pass iterative refinement | `rc-spectrum-long-orchestrator` | llama-4-scout | high `maxIterations`, 20-min timeout, sequential children |
| `40-model-compare-scout.yaml` | A/B test, scout side | `rc-spectrum-summarizer-scout` | llama-4-scout | identical prompt to 41 |
| `41-model-compare-llama70.yaml` | A/B test, 70B side | `rc-spectrum-summarizer-70b` | llama-3.3-70b | identical prompt to 40 |
| `50-multi-step-fanout.yaml` | Cross-model fanout | `rc-spectrum-fanout-orchestrator` | llama-4-scout (parent) | 3 children spread across both models |

## Models exercised

Both via the homelab's Cloudflare AI Gateway `/compat` endpoint
(see `new_localai/k8s-kustomized/overlays/production/kagent/model-endpoints.yaml`):

- `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`
- `workers-ai/@cf/meta/llama-3.3-70b-instruct`

The `model-endpoints.yaml` ModelEndpoint CRs feed both the
operator's admission reconciler (per-model in-flight cap) and the
gateway's AIMD tuner. Adding a third backend (OpenAI, Anthropic,
local vLLM) is a one-CR change — the agents in this bundle don't
need to know.

## Apply / re-run

```bash
# One-shot apply (new namespace).
kubectl apply -k examples/rc-spectrum/

# Re-run after a bundle edit. Argo's Sync hook + BeforeHookCreation
# delete-policy already does this on every commit-triggered sync;
# manual re-run pattern:
kubectl delete agenttasks -n kagent-rc-spectrum --all
kubectl apply -k examples/rc-spectrum/
```

## Pulling evidence

The new_localai overlay ships an evidence-collector Job
(`rc-spectrum-evidence-collector-job.yaml`) that mirrors the
`rc-pilot-evidence-collector` pattern but targets
`--namespace kagent-rc-spectrum --out /var/evidence/spectrum1`:

```bash
kubectl logs -n kagent-system job/rc-spectrum-evidence-collector \
  | tar xv -C ./evidence/spectrum1
```

The pack contains:
- `summary.md` — one row per AgentTask with phase + verification +
  artifact + audit columns, mirroring the rc-pilot summary shape.
- `tasks.json` + `task-details/<ns>__<name>.json` — full status
  + pilotEvidence projections.
- `healthz.json` / `readyz.json` — workbench-api liveness/readiness
  + cache counters captured at evidence-pack generation time.

## Reading the model A/B (40 vs 41)

`originalUserMessage` is byte-identical between the two scenarios.
Reviewer comparison:

- `status.result.content` — qualitative shape, factual accuracy,
  follows the "two sentences max" instruction.
- `status.usage.{prompt,completion,total}Tokens` — quantitative
  budget cost.
- `status.completedAt - status.startedAt` — round-trip latency
  through CF AI Gateway.
- `pilotEvidence.audit.model` — substrate-level audit attribution.

The substrate doesn't pick a winner; it captures observable signal
so the operator (homelab or otherwise) can.

## What this bundle deliberately does NOT cover

- Negative-path tests (`pod-boot-fail`, `forced-timeout`,
  `image-pull-fail`). Those live in `examples/rc-pilot/` and don't
  need re-coverage in the spectrum bundle.
- Verifier contracts (`verifyContract` / `outputContract`). Same —
  rc-pilot covers the substrate-level post-completion gate.
- Policy caps. Same — rc-pilot's 70-policy-cap.yaml is the
  reference.
- AgentTemplate / parameterized agents. Phase 5.x feature; not
  yet covered by an evidence rig.
