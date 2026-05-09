# North Star System Design

**Date:** 2026-05-08
**Status:** design north star; not an implementation spec
**Audience:** future agents and humans deciding what kagent should become
**See also:** [`PROTO-SOCIETY-DESIGN.md`](./PROTO-SOCIETY-DESIGN.md) — companion north star sized for emergent agent collectives on top of this workflow substrate; [`HYBRID-AGENT-POLICY.md`](./HYBRID-AGENT-POLICY.md) — per-agent reactive + deliberative policy.

This document captures the product and system model behind kagent's
Command Center direction. The 90s RTS analogy is useful, but it is only
the human layer. The real system is a self-organizing colony of agents,
tasks, tools, artifacts, workflows, and capability gates, all operating
under substrate laws.

The purpose of the substrate is not to make agents busy. It is to turn
intent into verified reusable capability while preserving authority,
observability, and resource accounting.

## 1. Core claim

kagent is a real-time autonomous work substrate.

The user supplies intent through ordinary channels. The system decomposes
that intent into task graphs, uses bounded resources over time, produces
artifacts and evidence, and promotes reusable capability only after
review.

The Command Center is a map of that substrate. It is not the substrate.

## 2. System layers

| Layer | Role | Examples |
|---|---|---|
| Channels | Where intent enters and results return | CLI, webhook, scheduler, GitHub, chat, Workbench |
| Work orders | Canonical unit of requested work | `AgentTask`, `AgentWorkflow` |
| Colony | Specialized execution nodes collaborating through substrate objects | Agents, child tasks, events, blackboard, artifacts |
| Economy | Continuous resource flows and constraints | model capacity, tokens/min, pod slots, storage, quota |
| Governance | Authority and promotion control | capability JWTs, verifiers, audit, human review |
| Human map | Situational awareness and intervention | Command Center, task detail, foundry, evidence views |

Every interface should create or inspect the same substrate objects. A
task created from chat, webhook, CLI, or canvas must produce the same
task graph, traces, artifacts, and audit trail.

## 3. The game loop, stated plainly

The system loop is:

```text
Intent -> Work -> Evidence -> Review -> Promotion -> Better Future Work
```

Users "play" by:

1. Submitting work through a normal channel.
2. Watching the substrate execute when useful.
3. Steering only when a task is blocked, over budget, or wrong.
4. Reviewing outputs and promotion proposals.
5. Approving reusable capability into the catalog.

The system wins when it produces more trustworthy work with less human
coordination, and every new power it gains is tested, scoped, observable,
and revocable.

## 4. Flow economy

The strongest operational metaphor is a flow economy, not a purchase
economy. Tasks do not simply "cost 200 tokens" up front. They consume
model capacity, context, pod slots, tool bandwidth, and artifact I/O over
time. When supply exceeds demand, work cooks smoothly. When demand
exceeds supply, work stalls, meters, queues, or fails with a substrate
reason.

| Flow | Substrate meaning | Typical pressure |
|---|---|---|
| model power | gateway/model endpoint capacity by model class | 429s, Retry-After, in-flight cap |
| token flow | prompt/output usage over time | cost overrun, context pressure |
| build power | agent concurrency and child fanout | too many in-flight tasks |
| pod capacity | schedulable Kubernetes execution | unschedulable, image pull, node pressure |
| artifact bandwidth | CAS/workspace read/write pressure | missing output, slow downstream consumers |
| authority | capability grants for tools/models/spawn/egress | policy denial |
| trust | verifier, detector, audit cleanliness | blocked promotion |
| attention | human review capacity | stale review queue |

The Command Center should make these flows visible. A base that is "all
busy" can be losing if low-value work saturates model power or fills the
review queue.

## 5. Collaboration pattern

Parent/child/N-child execution is the substrate's local coordination
pattern.

```text
root task
  -> parent agent
      -> child task A
      -> child task B
      -> child task C
  -> aggregate
  -> verify
  -> artifact
```

This pattern stays safe when:

- child task creation is capability-scoped
- fanout has depth and concurrency limits
- children write artifacts and status, not private side-channel state
- parent aggregation is visible in `AgentTask.status`
- failures are substrate-attributed
- retries are bounded and auditable

Agents may request children. The substrate decides whether those
children are allowed to exist.

## 6. Self-improvement pattern

The differentiating pattern is not one-off remote task execution. It is
controlled self-improvement.

Agents and workflows may discover repeated needs:

- a specialist prompt
- a reusable tool
- a verifier
- a workflow pattern
- a dataset or replay corpus
- a model-routing policy

They may propose new capability. They may not self-promote new authority.

The promotion loop is:

```text
candidate artifact
  -> verifier/tests/security/egress review
  -> human or policy approval
  -> versioned catalog object
  -> capability grant
  -> future tasks may use it
```

Promotion targets, in increasing authority risk:

| Target | Use when | Risk |
|---|---|---|
| Prompt/versioned instruction | output style or reasoning pattern improved | low |
| AgentTemplate | repeatable specialist role emerged | medium |
| Verifier | acceptance contract became reusable | medium |
| Workflow | durable orchestration pattern emerged | medium-high |
| Tool | executable behavior or external access emerged | high |
| Capability policy | new authority should be granted | highest |

Recommendation: start with artifacts, verifier status, and
`AgentTemplate` promotion. Do not add a general `Tool` CRD until a real
candidate tool forces the design.

## 7. Steering and review

The system needs a feedback mechanism that is more structured than
comments and less dangerous than direct mutation.

There are three feedback classes:

| Feedback class | Source | Purpose |
|---|---|---|
| Steering | human or workflow | change priority, budget, route, retry, cancel, or model class |
| Review | human, verifier, evaluator | accept/reject result or promotion candidate |
| Learning signal | substrate telemetry | update future defaults, prompts, tests, or routing policy |

### 7.1 Steering events

A steering event should be an auditable input to the substrate.

Examples:

- raise priority for a task
- lower priority for background work
- cancel or pause a task tree
- retry with a different model class
- request a child split
- extend a budget
- force human review before completion

Initial implementation can be annotations or existing API actions. Later
implementation may deserve a first-class `SteeringEvent` or
`TaskReview` object. Do not add the CRD before the first two or three
actions prove the shape.

Minimum fields:

```yaml
kind: SteeringEvent
spec:
  target:
    kind: AgentTask
    namespace: kagent-system
    name: example
  intent: raise_priority
  reason: "customer-visible task"
  requestedBy: "user@example.com"
  expiresAt: "2026-05-08T22:00:00Z"
status:
  accepted: true
  appliedAt: "..."
  auditEventId: "..."
```

### 7.2 Review queue

Review is the bridge between autonomous output and durable capability.

Reviewable objects:

- terminal task results
- verifier failures
- suspicious detector flags
- candidate tool artifacts
- candidate AgentTemplates
- proposed capability grants
- proposed egress/domain additions
- workflow promotions

A review should capture:

- target object
- reviewer identity
- decision: accept, reject, request changes, quarantine
- reason
- expiration or follow-up task
- audit event id

The Command Center may render this as a Foundry or Council surface, but
the substrate should treat it as structured governance input.

### 7.3 Learning signals

Learning signals should never mutate authority directly. They inform
future proposals.

Inputs:

- completion rate
- verifier pass/fail
- structural detector flags
- cost and latency
- model/provider failure rates
- human acceptance/rejection
- replay/eval results
- promotion outcomes

Outputs:

- suggested prompt updates
- suggested verifier updates
- suggested model routing changes
- suggested template changes
- suggested tool promotion or quarantine

The safe rule:

```text
signals may propose; governance disposes
```

## 8. Interface model

The RTS layer should not replace normal interaction.

| User need | Best interface |
|---|---|
| submit ordinary work | CLI, webhook, chat, GitHub, scheduler, simple Workbench form |
| see status of one task | task detail |
| understand active system pressure | Command Center |
| investigate a failure | task detail + trace + pod/job summary |
| review output | review queue |
| promote reusable capability | Tool Foundry / template catalog |
| audit a pilot | evidence pack |

The Command Center is most valuable when tables flatten too much:
fanout, resource pressure, blocked production, promotion queues, and
cross-agent collaboration.

## 9. Enemies become pressure, not lore

The system does not need fictional opponents. The real antagonists are:

- overdrawn model capacity
- runaway fanout
- missing authority
- stale telemetry
- verifier debt
- context pressure
- quota walls
- bad tool outputs
- unreviewed promotions

This keeps the visual language honest. The operator is not fighting a
fictional battle; they are managing a living autonomous work economy.

## 10. Winning conditions

For a task, winning means:

- output delivered
- verifier passed or review recorded
- trace and artifacts linked
- detector flags clean or explicitly reviewed
- cost and latency inside budget

For a workflow, winning means:

- child tasks aggregate cleanly
- retries are bounded
- blocked states are explainable
- final artifact is accepted

For the colony, winning means:

- repeated work becomes reusable capability
- promoted capability is tested, scoped, versioned, and revocable
- resource stalls are visible before they become outages
- authority does not expand silently
- human review load trends down per unit of useful output

For the project, winning means:

- any channel can create the same work order
- every channel produces the same evidence trail
- the substrate can add hardware, tools, agents, and workflows without
  changing its laws

## 11. Bounds

Something belongs inside the system only if it can be represented as:

```text
declared capability
+ bounded resource drain
+ observable state transition
+ auditable output
+ revocation path
```

Physical hardware can join the system when it has:

- declared actions
- declared resources
- telemetry
- failure modes
- capability policy
- audit trail
- shutdown or disable path

This applies equally to GPU nodes, browser pools, NAS storage, cameras,
lab devices, or any future external actuator.

## 12. North-star objects

Do not add all of these now. They name the durable concepts the system
keeps circling:

| Concept | Possible object | Current nearest substrate |
|---|---|---|
| work order | `AgentTask`, `AgentWorkflow` | exists |
| candidate capability | `ArtifactRef` + verifier metadata | exists partially |
| review | future `TaskReview` or annotations | not yet |
| steering | future `SteeringEvent` or action API | partial via actions |
| promoted specialist | `AgentTemplate` | exists |
| promoted executable tool | future `Tool` CRD | not yet |
| reusable acceptance test | verifier contract | exists partially |
| economy snapshot | Workbench DTO over gateway/quota/task state | partial |

The next implementation agent should prefer overlays on existing objects
until a concept repeats enough to justify a CRD.

## 13. Implementation posture

Near term:

1. Keep the Command Center source-bound.
2. Add read-depth before write-depth.
3. Add resource-flow overlays.
4. Add review queues over existing task/artifact/verifier state.
5. Add Tool Foundry read model over candidate artifacts.

Medium term:

1. Add bounded steering actions.
2. Add promotion workflow for AgentTemplates.
3. Add replay/eval signals into review.
4. Add resource priority/metering semantics.

Long term:

1. Decide whether promoted tools require a `Tool` CRD.
2. Decide whether steering/review require first-class CRDs.
3. Decide whether agent-sandbox becomes the isolation backend.
4. Decide how physical hardware appears as resource producers and
   tool-bearing structures.

## 14. Non-goals

- No UI-only world state.
- No direct self-granting authority.
- No hidden self-modifying production code.
- No arbitrary YAML editor as the main product surface.
- No chat-first product pivot.
- No visual metaphor that hides failures.
- No new CRD until repeated behavior proves it belongs in the substrate.

## 15. One-sentence test

Every future feature should answer:

> Does this help the system turn intent into verified reusable capability
> with clearer authority, resource accounting, observability, review, or
> revocation?

If not, it is likely ornament, application code, or model-gateway scope.

