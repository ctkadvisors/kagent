# Task resume

**Date:** 2026-11-26. NORTH-STAR §3 step: **Work**. Object: `AgentTask`.

A task that stops before it finishes is followed by a new task that continues its saved conversation, instead of the work being lost. On 2026-11-26, 138 of the 207 retained failed tasks in the homelab had ended at their time limit.

## How it works

1. **Checkpoint.** With the artifact volume mounted (`ARTIFACTS.md` §10), the agent pod saves the conversation before every model call to `<artifacts>/<task-uid>/.kagent/checkpoint.json`. The saved state is the exact message list the loop was about to send, so it is always resumable and already fits the window. `packages/agent-pod/src/checkpoint.ts` does this by wrapping the model client; the loop is not changed. The file's ref (with its sha256) is one of the task's `status.artifacts`.
2. **Continuation.** When a task ends `Failed` at its time limit, its iteration cap or a killed pod, and its Agent carries the annotation `kagent.knuteson.io/max-continuations: "<n>"`, the operator creates a new `AgentTask` named `<task>-cont<k>` with the same spec and labels (`packages/operator/src/continuation.ts`). Its annotations name the task it continues and that task's checkpoint digest.
3. **Resume.** The continuation's pod loads the checkpoint only if the file matches that digest and was written by the same Agent in the same namespace. The annotations alone prove nothing about who set them; these two checks bound what a task can resume. It starts from the saved conversation under the Agent's current system prompt, with one added message saying what happened and what was lost. If there is no usable checkpoint, it is a fresh run of the same work, and the pod log says why.

## What does not carry over

- The code-interpreter sandbox: a new task has a new, empty workspace. The resume message tells the agent to recreate what it still needs. Work that was committed, posted or written with `write_artifact` survives.
- The model call in flight when the task stopped, and its tool calls.
- The loop's iteration and token counters: a continuation has its own budget.

## Limits

- Opt-in per Agent, at most 5 continuations whatever the annotation says.
- A child task is continued as a sibling under the same parent. The parent's `wait_for_child_task` follows the child to its continuation and returns that result with `continuedFrom`; `wait_for_children_all` counts the continuation instead of the run it replaced. After a time-limit failure the wait gives the operator 20 seconds to create the continuation before reporting the failure. The parent's `status.aggregatePhase` still counts the first run as failed.
- Not continued: a model backend error, a context-window refusal, a policy denial.
- A task that finished more than an hour ago is never continued.

## Seeing it

- Operator log: `continuation: <ns>/<task> → <task>-cont1 (<error>)`.
- Pod log: `resume: continuing <task> (<uid>) from model call <n>, <m> messages`.
- The continuation's annotations: `kagent.knuteson.io/continues-name`, `continues-uid`, `continuation-index`.
