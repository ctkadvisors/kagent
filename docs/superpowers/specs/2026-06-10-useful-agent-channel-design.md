# Useful Agent Channel Design

## Goal

Make kagent useful as a local, k8s-native operator surface: a WhatsApp-style controller channel that can launch typed agents with local rich tools, show every session, enforce failure stops, and prove value with one real operator workflow.

## Current State

Shipped:

- Workbench has a Sessions route and API.
- Sessions can create `AgentTask` resources and reconstruct user/assistant turns from task labels and status.
- The deployed Workbench is running `v0.2.18-workbench-sessions-rc.2`.
- Gateway usage shows the recent failing session used the local `nemotron-3-nano:4b` backend, not Cloudflare, with zero recorded tokens/cost for the failed attempts.
- Gateway failure backoff opened after the local backend failed, which stopped immediate retry spam.

Not yet proven:

- A deployed session has not completed a useful rich-tool run.
- The current local tool-calling path can fail before tool execution with LocalAI XML/template errors.
- The Sessions UI is not yet the controller for typed agent profiles; it is still close to raw task creation.
- Failure controls are not visible or controllable enough from the operator surface.

## Architectural Position

kagent should not become a pile of custom bespoke tools. The controller should compose existing local tool runtimes:

- Browser runtime: local Steel-compatible browser service or equivalent browser pod.
- Code runtime: Kubernetes-native sandbox such as `kubernetes-sigs/agent-sandbox`.
- External tools: MCP servers and ad hoc HTTP tools registered through the tool gateway.
- Agent behavior: typed `Agent` or `AgentTemplate` profiles selected by the channel, not hard-coded into the UI.

The channel should be a control plane, not the runtime. It creates bounded `AgentTask`s, watches their state, displays traces/results, and exposes kill/backoff state.

## Required Design Decisions

### 1. Agent Types Are First-Class

The channel should create sessions against named agent types/profiles such as:

- `research-browser-code`
- `repo-triage`
- `incident-investigator`
- `project-tracker-operator`

Each type resolves to:

- target namespace
- target `Agent` or `AgentTemplate`
- model class
- tool profile
- timeout and iteration defaults
- budget defaults
- operator-facing description

The UI should consume those types from the API/gateway state instead of asking the operator to know raw agent names.

### 2. Tool Profiles Must Be Model-Compatible

Do not debug LocalAI XML failures only at the symptom level. First classify model/tool compatibility:

- No tools: model can complete ordinary chat.
- Simple tool: model/backend accepts one OpenAI-style function.
- Dotted runtime tool: model/backend accepts names like `browser.goto`.
- Full runtime profile: model/backend accepts the actual browser/code descriptors.
- Tool round trip: model emits a tool call, the loop executes it, and the continuation succeeds.

If a backend fails any required class, mark that model class unavailable for that tool profile. The controller must refuse to launch a rich-tool agent on an incompatible model class unless explicitly overridden.

Likely implementation outcome: add a compatibility adapter that gives the LLM safe tool aliases, then maps aliases back to canonical gateway names. Canonical names can stay `browser.goto` and `code_interpreter.execute_code`; the LLM-facing names may need to be `browser_goto` and `code_interpreter_execute_code` for brittle local runtimes.

### 3. Failure Stops Are Product Behavior

Failure control is part of the controller feature, not an internal gateway detail.

The channel should surface:

- provider/model backoff state
- disabled provider/model state
- in-flight task count
- recent failure reason
- whether a session is launchable right now

The system should stop deterministically on:

- model/tool compatibility failure
- repeated provider failure
- task timeout
- iteration cap
- explicit operator kill

For deterministic compatibility failures, do not retry the same request shape. Fail closed, mark the model/profile combination unhealthy, and show the operator why.

### 4. Real-World Validation Is One Workflow

Use one useful scenario as the acceptance test, not a toy prompt:

> "Investigate why kagent rich-tool agents are failing. Inspect recent gateway failures, inspect the relevant agent/tool profile configuration, use browser/code tools only if needed, and return an operator note with root cause, evidence, and next action."

Acceptance criteria:

- The session is created from the controller UI.
- The selected agent type is visible.
- The run uses local model/backend unless an override is explicit.
- The run uses at least one rich tool when the agent decides it is needed.
- Gateway usage shows no Cloudflare spend for the local run.
- The session page shows the full user/assistant turn history.
- Failure/backoff/killswitch state is visible if anything fails.
- The result is useful enough for an operator to act on.

## Implementation Plan

### Phase 1: Stop Guessing About Tool Compatibility

Add a small compatibility probe path that can run against the deployed gateway/model classes:

1. no-tool chat
2. one simple tool
3. one dotted tool name
4. actual browser/code tool descriptors
5. full tool-call round trip

Record the result by model class and tool profile. This establishes whether the LocalAI failure is a name/schema/template issue or a broader backend limitation.

### Phase 2: Make Tool Names Backend-Safe

If the probe proves dotted names or descriptor shape are the issue, add LLM-facing aliases:

- `browser.start_session` -> `browser_start_session`
- `browser.goto` -> `browser_goto`
- `browser.extract_text` -> `browser_extract_text`
- `code_interpreter.execute_code` -> `code_interpreter_execute_code`

The agent loop should send aliases to the LLM and map tool calls back to canonical names before dispatch. Traces should record both names when they differ.

### Phase 3: Expose Typed Agent Profiles To Sessions

Add an API surface for launchable session profiles. The Sessions UI should show these profiles as the primary target selector and hide raw agent names behind details.

Each profile should carry launchability:

- `ready`
- `blocked_by_backoff`
- `blocked_by_model_tool_compatibility`
- `blocked_by_missing_runtime`
- `disabled_by_killswitch`

### Phase 4: Wire Failure Controls Into The Controller

Add channel-visible controls and state:

- global dispatch disabled/enabled
- provider/model disabled/enabled
- current backoff window
- stop/kill task
- clear backoff only when safe

The controller should not create new rich-tool sessions when the selected profile is blocked.

### Phase 5: Validate One Real Operator Run

Use headed Playwright against deployed Workbench:

1. open `https://kagent.knuteson.io/#/sessions`
2. create a new session using the intended typed profile
3. send the real operator workflow prompt
4. wait for terminal state
5. inspect session output
6. inspect gateway usage/cost/backend
7. inspect task logs if needed
8. capture the result as evidence

## Non-Goals

- Do not build custom bespoke tools for every workflow.
- Do not depend on Cloudflare for the default local operator path.
- Do not hide local backend incompatibility by silently falling back to paid/cloud models.
- Do not expand the UI into a general workflow builder before one real typed agent path works.

## Immediate Next Step

Run the model/tool compatibility probes against the deployed gateway and current local model. The result determines whether the next code change is:

- tool aliasing/schema normalization,
- model-class compatibility gating,
- tool-profile registration changes,
- or replacing the local tool-calling backend for rich-tool profiles.

