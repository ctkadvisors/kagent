# Workbench Channel Sessions Design

Date: 2026-06-10
Status: approved for implementation by user request ("do it")

## Goal

Add a WhatsApp-style channel inside kagent Workbench so an operator can talk to the controller and see every session, without bypassing AgentTask, gateway profiles, model routing, kill switches, traces, or audit.

## Scope

This slice builds the internal web channel first:

- session list
- session detail timeline
- message composer
- task creation through the existing `POST /api/tasks` path semantics
- task/result linking in the timeline

External bridges such as WhatsApp, Telegram, Hermes, or OpenClaw adapters are deferred to a follow-up. They will call the same session-message API instead of receiving separate authority.

## Architecture

The Workbench API owns a thin channel projection over existing substrate objects.

```text
Workbench Sessions UI
  -> workbench-api /api/sessions
  -> AgentTask CRs with channel labels/annotations
  -> operator/agent-pod/controller
  -> status.result / trace / pod state
  -> workbench-api cache + SSE
  -> Sessions UI timeline refresh
```

No new runtime is introduced. A user message creates an `AgentTask` targeted at the selected controller agent. Session identity is durable because every turn is stamped onto the task with labels:

- `kagent.knuteson.io/channel=workbench`
- `kagent.knuteson.io/channel-session=<session-id>`
- `kagent.knuteson.io/channel-turn=<turn-id>`

Message display derives from task spec/status:

- user message: `AgentTask.spec.originalUserMessage`
- assistant message: `AgentTask.status.result.content` or `status.error`
- task link: namespace/name/uid/phase/trace

The first implementation does not persist empty sessions. A session exists after its first submitted message. That keeps the slice small and avoids a new CRD or ConfigMap write path.

## API

`GET /api/sessions`

Returns sessions grouped from channel-labelled tasks, newest activity first.

`GET /api/sessions/:sessionId`

Returns session metadata and ordered message turns with linked task summaries.

`POST /api/sessions/:sessionId/messages`

Creates a new `AgentTask` for the session. Request fields:

- `targetAgent`: required controller/agent name
- `namespace`: optional, defaults to the Workbench API namespace
- `message`: required user message
- `runConfig`: optional bounded task run config

The route validates the session id, message, target, namespace, payload size, and target agent visibility using the same cache/Kubernetes pattern as `POST /api/tasks`.

## UI

Add `#/sessions`.

Layout:

- left pane: all sessions, newest activity, target agent, last phase, turn count
- main pane: timeline with user bubbles and controller/task result bubbles
- composer: target agent selector plus message input
- linked task affordance: open TaskDetail for any turn

The route uses existing same-origin fetch and SSE. On task cache events, it refetches session list/detail. The page is operational, not decorative.

## Safety

- All work still creates `AgentTask` CRs.
- No direct pod exec or hidden prompt playground.
- No raw tool grants from the channel.
- No external cloud/messaging credential wiring in this slice.
- Existing `DELETE /api/tasks` remains the kill path for a running turn.
- Session ids are constrained to DNS-label-like lowercase ids.

## Verification

- API tests cover grouping, detail projection, message validation, and task creation metadata.
- UI tests cover session list rendering, timeline rendering, and composer submission.
- Typecheck and lint pass for Workbench API/UI.
- Browser UAT verifies `#/sessions` renders, a message can be submitted to a controller agent, and the created task appears in Tasks.
