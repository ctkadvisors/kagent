# Local AgentCore Runtime Plane - Design

**Date:** 2026-06-08
**Status:** Approved design, pre-implementation
**Goal:** Add a K3s-native tool runtime plane where every tool-using agent receives its own isolated browser and code-runner sessions, with no ambient env bleed, bounded failure behavior, and a verified real-world agent run that uses both tools.

---

## 1. Problem

kagent currently proves the substrate can run bounded LLM jobs, mint capability-narrowed child tasks, write artifacts, and expose traces. It does not yet prove the operator can run a useful real-world agent with rich tools comparable to AWS AgentCore's built-in Browser and Code Interpreter.

The gap is not "find more MCP servers." The user already has richer local agents in sibling repos (`project_tracker`, Hermes, OpenClaw, SeekArc) and has used Steel on Fly.io for browser automation. The missing substrate primitive is a local, Kubernetes-native runtime plane that gives an agent ephemeral tools without exposing host SSH, shared process env, shared browser state, cluster credentials, or cross-agent state.

The previous failure mode makes the safety requirements concrete:

- Bad model routing caused task spam against Cloudflare AI Gateway.
- Failed agents retried without useful backoff or operator-visible stop controls.
- Browser/code tools, when added, would multiply that blast radius unless each session is bounded, killable, and audited.

This design moves kagent from "bounded LLM job runner" to "bounded local operator" by adding two generic tool runtimes:

1. `code_interpreter`: a per-agent code/files/command sandbox.
2. `browser`: a per-agent Steel/Chrome browser sandbox with CDP/Playwright control and live view.

Both are exposed through a local tool gateway that can also attach MCP servers and simple HTTP/ad hoc tools without turning the sandbox itself into a smart agent.

## 2. External parity targets

This design targets feature parity with the AgentCore tool surfaces, not AWS integration.

| Capability | AWS AgentCore target | Local equivalent |
|---|---|---|
| Browser session | AgentCore Browser managed Chrome session, live view, Playwright/CDP style control | `browser-steel-v1` sandbox template running Steel Browser locally |
| Code execution | AgentCore Code Interpreter `executeCode`, file operations, command/task lifecycle | `code-runner-v1` sandbox template running a minimal file/exec server |
| Session lifecycle | Explicit create/use/stop/release | `ToolSession` records plus agent-sandbox `SandboxClaim` TTL and explicit terminate |
| Isolation | Hosted sandbox | Kubernetes Sandbox/SandboxClaim with RuntimeClass, NetworkPolicy, no SA token |
| Tool gateway | AgentCore tools/Gateway/inline tools | `agent-tool-gateway` exposing MCP + OpenAI-compatible tool schemas |

Reference facts used in this design:

- AgentCore Code Interpreter supports sandboxed code execution and file operations such as `executeCode`, `writeFiles`, and related session actions.
- AgentCore Browser enables agents to interact with web pages through a managed Chrome browser and supports live viewing and Playwright-style automation.
- `kubernetes-sigs/agent-sandbox` provides `Sandbox`, `SandboxTemplate`, `SandboxClaim`, and `SandboxWarmPool` as Kubernetes-native isolated runtime primitives.
- Steel Browser is self-hostable via Docker images and exposes browser sessions through HTTP/CDP, including Playwright `connectOverCDP` usage and explicit session release.

## 3. Decision summary

| Question | Decision |
|---|---|
| Use agent-sandbox or keep hand-built Jobs? | **Use agent-sandbox for tool runtimes.** kagent keeps Agent/AgentTask semantics and delegates per-session runtime isolation to SandboxTemplate/SandboxClaim. |
| Browser shape? | **Per-agent Steel sandbox.** Each tool-using AgentTask gets its own Steel browser session, not a shared Steel Deployment. |
| Code runner shape? | **Per-agent code sandbox.** Each tool-using AgentTask gets its own code runner workspace with file and exec API. |
| Tool exposure? | **Local tool gateway exposes both MCP and OpenAI-compatible tool schemas.** This lets kagent, Hermes, OpenClaw, and project_tracker consume the same runtime plane. |
| Env handling? | **Fail-closed env allowlist.** Sandboxes receive only explicit runtime env, never inherited process env. Secrets stay in the gateway/credential broker unless explicitly mounted by policy. |
| Sandbox intelligence? | **Dumb sandbox invariant.** Sandboxes execute commands/browser actions only. No LLM keys, no tool-selection logic, no cluster credentials, no ambient MCP config. |
| Backoff/kill switch? | **Required before broad use.** Per-session TTL, per-agent concurrent session cap, retry budget, gateway stop endpoint, and cluster-wide runtime pause are part of v1 acceptance. |
| First useful UAT? | **A browser+code agent that investigates a live web app, extracts evidence with browser, analyzes/transforms it with code, and writes a reviewed artifact.** |

## 4. Architecture

```
AgentTask
  |
  | requires tools: browser, code_interpreter
  v
Operator
  |
  | creates AgentTask Job
  | creates/claims per-task tool sessions
  v
agent-pod ----------------------+
  |                             |
  | tool calls over localhost/  |
  | cluster-private HTTP/MCP    |
  v                             |
agent-tool-gateway              |
  |                             |
  | creates SandboxClaims       |
  | routes calls by session id  |
  | enforces caps/backoff/env   |
  v                             v
SandboxClaim/code-runner     SandboxClaim/browser-steel
  |                             |
  v                             v
code-runner pod              Steel browser pod
```

### 4.1 Components

| Component | New / Changed | Location |
|---|---|---|
| `@kagent/tool-gateway` | New package; HTTP + MCP tool gateway and session manager | `packages/tool-gateway/` |
| `ToolSession` DTOs | Shared schemas for browser/code sessions and tool-call audit | `packages/dto/src/tool-session.ts` |
| Operator runtime wiring | New reconciler that provisions tool sessions for AgentTasks with declared tool runtimes | `packages/operator/src/tool-runtime/` |
| Agent-pod tool client | New built-in provider that calls the gateway instead of spawning local tools | `packages/agent-pod/src/tool-gateway-client.ts` |
| Code-runner template | New agent-sandbox `SandboxTemplate` and image definition | chart/manifests under `packages/operator/charts/kagent-operator/` |
| Browser Steel template | New agent-sandbox `SandboxTemplate` for self-hosted Steel | chart/manifests under `packages/operator/charts/kagent-operator/` |
| Runtime policies | ValidatingAdmissionPolicy/Kyverno-style manifests for no-bleed sandbox defaults | chart/manifests under `packages/operator/charts/kagent-operator/` |
| UAT scenario | New example bundle that runs a useful browser+code task | `examples/local-agentcore-runtime/` |

### 4.2 Runtime ownership model

Each `AgentTask` owns a `ToolSessionSet` in practice, even if the final storage is labels/annotations rather than a new CRD. A session is addressed by:

```text
tenant / namespace / agentTaskUid / toolKind / sessionId
```

The tool gateway rejects calls unless all of these match the caller's capability token:

- task UID
- agent name
- namespace
- granted tool name
- session id
- expiration

This prevents one agent from discovering another session id and using it. The session id alone is not a bearer credential.

### 4.3 Dumb sandbox invariant

The code and browser sandboxes are intentionally boring.

They may have:

- a tiny HTTP control server
- a workspace directory
- stdout/stderr capture
- Chrome/Steel for browser sessions
- language runtimes required by the template

They must not have:

- LLM API keys
- Cloudflare/OpenAI/Anthropic credentials
- kubeconfig or mounted ServiceAccount tokens
- MCP server configs
- git credentials unless a policy explicitly grants a short-lived repo token
- parent process env
- authority to create other sandboxes
- authority to call the kagent API server directly
- tool-selection or planning logic

If a sandbox is compromised, the expected blast radius is its own workspace, its own browser state, and any explicitly granted egress for that one session.

## 5. Tool contracts

### 5.1 `code_interpreter`

The first implementation exposes these tools:

| Tool | Purpose |
|---|---|
| `code_interpreter.start_session` | Create or fetch the task-scoped code sandbox |
| `code_interpreter.execute_code` | Run inline Python/JavaScript/TypeScript in the workspace |
| `code_interpreter.execute_command` | Run an allowlisted shell command with timeout and output cap |
| `code_interpreter.start_command` | Start a long command and return a task id |
| `code_interpreter.read_files` | Read one or more workspace files with byte caps |
| `code_interpreter.write_files` | Write one or more workspace files under the workspace root |
| `code_interpreter.list_files` | List workspace paths |
| `code_interpreter.stop_task` | Stop a long-running command |
| `code_interpreter.terminate_session` | End the sandbox and release resources |

Command policy is allowlist-first. Initial allowlist:

```text
node, npm, npx, pnpm, yarn, python, python3, pip, pip3,
tsc, eslint, prettier, vitest, jest, pytest,
git, rg, grep, find, sed, awk, cat, head, tail, wc, diff,
ls, pwd, env, printenv, jq
```

Dangerous commands are denied even if present in the image:

```text
kubectl, helm, docker, podman, ssh, scp, curl-to-metadata, sudo,
mount, chmod 777 outside workspace, rm outside workspace
```

The gateway enforces:

- working directory must be the session workspace
- file paths must stay under workspace root
- stdout/stderr truncation
- wall-clock timeout
- max concurrent commands per session
- max command retries per tool call

### 5.2 `browser`

The first implementation exposes these tools:

| Tool | Purpose |
|---|---|
| `browser.start_session` | Create or fetch the task-scoped Steel browser sandbox |
| `browser.goto` | Navigate to a URL allowed by egress policy |
| `browser.click` | Click a selector or role target |
| `browser.type` | Type into a field |
| `browser.select` | Select dropdown options |
| `browser.wait_for` | Wait for visible text or selector |
| `browser.screenshot` | Capture screenshot artifact |
| `browser.extract_text` | Return visible page text with caps |
| `browser.cdp_url` | Return an internal CDP URL for approved debuggers |
| `browser.live_view_url` | Return an operator-facing live view URL |
| `browser.recording_url` | Return recording URL if recording is enabled |
| `browser.terminate_session` | Release the Steel session |

The browser tool must default to a clean profile per task. Reusing browser context is opt-in only and must be scoped by tenant/user credential policy, not by agent preference.

### 5.3 MCP and ad hoc tool hook

The gateway exposes a tool-provider registry:

```yaml
toolProviders:
  - name: browser
    kind: builtin
  - name: code_interpreter
    kind: builtin
  - name: playwright-mcp
    kind: remoteMcp
    url: http://playwright-mcp.agent-runtime.svc/mcp
  - name: github-readonly
    kind: http
    baseUrl: https://api.github.com
    authRef:
      secretName: github-readonly-token
      key: token
```

Important boundary: MCP servers and ad hoc HTTP tools do not run inside the agent-pod by default. They are either:

1. remote services already isolated by deployment policy, or
2. subprocesses run inside their own dumb code-runner session with the same env allowlist behavior.

No MCP server gets the tool gateway's full process env.

## 6. Env and secret handling

This is a hard invariant: no agent runtime inherits ambient environment variables into a sandbox.

### 6.1 Allowed default env

The gateway may inject only:

```text
HOME=/workspace
TMPDIR=/tmp
PATH=<image-defined-safe-path>
LANG=C.UTF-8
KAGENT_TASK_UID=<uid>
KAGENT_AGENT_NAME=<name>
KAGENT_NAMESPACE=<namespace>
KAGENT_TOOL_SESSION_ID=<session id>
KAGENT_TOOL_KIND=<browser|code_interpreter>
```

The gateway must not inject:

```text
OPENAI_API_KEY
CLOUDFLARE_API_TOKEN
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
KUBECONFIG
KUBERNETES_SERVICE_HOST
KUBERNETES_SERVICE_PORT
GITHUB_TOKEN
LANGFUSE_SECRET_KEY
DATABASE_URL
```

If a language runtime needs `PATH`, `HOME`, or cert bundle paths, those are image-defined and reviewed in the template. They are not copied from the gateway pod.

### 6.2 Secret broker

Some useful agents need credentials. For example, a SeekArc-style browser agent may need a site login. The design handles that through a credential broker, not env inheritance:

1. Agent requests a named credential use, e.g. `credential.use("seekarc-demo-login")`.
2. Gateway checks the task capability token and policy.
3. Gateway performs the minimal action:
   - injects form fields through the browser tool, or
   - mounts a short-lived file into the sandbox if the policy says file access is required.
4. The credential value is never returned to the LLM as tool output.
5. Every use is audited with credential name, not value.

No credential broker is required for the first UAT if public targets are sufficient.

## 7. Failure control

Tool runtimes must fail boringly.

### 7.1 Backoff and retry budget

Per `(agentTaskUid, toolKind)`:

- max failed starts: 3
- backoff: 5s, 20s, 60s
- after budget is exhausted, mark the tool unavailable and return a tool error to the agent
- do not create more pods after the tool start budget is exhausted

Per tool call:

- no automatic retry of side-effecting browser actions
- read-only calls may retry once on gateway transport failure
- model-level retries do not reset tool retry budgets

### 7.2 Kill switches

Required kill switches:

| Switch | Scope | Mechanism |
|---|---|---|
| `toolRuntime.enabled=false` | cluster-wide | Gateway returns `tool_runtime_paused`; operator stops creating new SandboxClaims |
| `toolRuntime.browser.enabled=false` | browser only | Browser tools unavailable; existing sessions terminated after grace |
| `toolRuntime.code.enabled=false` | code only | Code tools unavailable; running commands stopped |
| `toolRuntime.maxSessions=0` | admission drain | No new sessions; existing sessions continue or terminate based on policy |
| per-task stop | one AgentTask | Gateway terminates sessions and patches task condition |

The Workbench should surface these states in the Gateway/Tasks pages before write controls are added.

### 7.3 Cleanup

Every session has:

- hard TTL
- idle TTL
- owner label pointing to AgentTask UID
- final artifact sweep
- explicit `terminate_session` path
- gateway startup cleanup for orphaned sessions

Default TTLs:

```yaml
code:
  idleTtlSeconds: 600
  maxTtlSeconds: 3600
browser:
  idleTtlSeconds: 300
  maxTtlSeconds: 1800
```

## 8. Kubernetes policy

Tool sandboxes run in namespace `kagent-runtime` by default. They are not scheduled into the agent's namespace unless a tenant policy explicitly requires that.

Baseline sandbox pod requirements:

- `automountServiceAccountToken: false`
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` where image allows
- drop all Linux capabilities
- no host network
- no host PID/IPC
- no hostPath volumes
- resource requests and limits required
- RuntimeClass `gvisor` or `kata` when available; default runtime allowed only for dev
- NetworkPolicy default deny ingress/egress
- egress allowlist per tool template

The operator chart must ship a validation layer that rejects sandbox templates violating these requirements when runtime policy is enabled.

## 9. kagent integration

### 9.1 Agent tool declaration

Agents opt into tool runtimes through their existing tool/capability surfaces. The new fields should be additive and conservative:

```yaml
spec:
  tools:
    - browser.goto
    - browser.screenshot
    - browser.extract_text
    - code_interpreter.execute_code
    - code_interpreter.write_files
    - write_artifact
  toolRuntime:
    isolation: perTask
    browser:
      templateRef: browser-steel-v1
    code:
      templateRef: code-runner-v1
```

If `toolRuntime` is absent, existing no-tool agents behave as they do today.

### 9.2 Capability narrowing

The existing child-spawn invariant remains:

```text
child tools subset parent tools
```

The new runtime-plane invariant is:

```text
child tool sessions are new sessions, never inherited sessions
```

A parent can grant a child `browser.*`, but it cannot hand the child its browser cookies, CDP URL, code workspace, process id, or env. Shared artifacts must go through `write_artifact`/CAS/workspace policy, not live session sharing.

### 9.3 Observability

Every tool call emits:

- task UID
- agent name
- session id
- tool kind
- tool name
- arguments redacted by schema
- latency
- output size
- error class
- retry count
- sandbox name/pod UID
- artifact refs for screenshots/files

Trace sinks should render tool calls as Langfuse tool spans and gateway rows. The Workbench should show a task's browser/code sessions with terminate buttons once write RBAC is available.

## 10. First useful agent UAT

The first proof must be more than "hello world." It should demonstrate a realistic workflow with both tools.

### Scenario: web regression investigator

Input:

```text
Inspect the live kagent Workbench task and gateway pages. Find the most recent failed or suspicious task/gateway request, capture browser evidence, analyze the visible data with code, and write a short operator report with concrete next actions.
```

Expected agent behavior:

1. Start browser session.
2. Navigate to `https://kagent.knuteson.io/#/tasks`.
3. Extract visible task table text and take screenshot.
4. Navigate to `https://kagent.knuteson.io/#/gateway`.
5. Extract recent request data and take screenshot.
6. Start code session.
7. Write the extracted rows to a JSON/CSV file.
8. Run code that groups failures by model/status/error and identifies repeated bad-model or retry-loop patterns.
9. Write an artifact report containing:
   - what pages were inspected
   - screenshots/artifact refs
   - failure grouping
   - whether any active/pending retry loop is visible
   - recommended operator action
10. Terminate browser and code sessions.

This is useful because it exercises the exact operational pain that triggered the work: runaway failed agents, gateway spam, model routing drift, and lack of confidence that the tool-using agent is bounded.

Acceptance evidence:

- AgentTask reaches `Completed`.
- Langfuse/gateway shows bounded LLM calls.
- Workbench shows no runaway active/pending tasks after completion.
- Tool gateway shows exactly one browser session and one code session for the task.
- Browser screenshots exist as artifacts.
- Code workspace files exist as artifacts.
- Both sessions terminate by explicit call or TTL.
- The report is materially useful to an operator, not a canned summary.

### Optional second UAT: SeekArc-style application helper

If Workbench auth blocks the first UAT, use a public demo target:

1. Browser visits a public job listing or mock application page.
2. Code runner transforms a supplied resume/profile into targeted bullets.
3. Browser fills a mock application form.
4. Agent writes a report with what it filled and why.

This mirrors the `ai-interviewer/` SeekArc pattern without depending on production credentials.

## 11. Phasing

### Phase 1: spec and contracts

- Write this design.
- Add exact DTO/tool schemas.
- Add tests for env allowlist, session ownership, and tool schema shape.

### Phase 2: code-runner MVP

- Implement `@kagent/tool-gateway` session manager for code sessions.
- Add a local dev code-runner implementation that can run without agent-sandbox for unit tests.
- Add the real agent-sandbox template manifests.
- Verify file read/write, command execution, timeout, stop task, and env denylist.

### Phase 3: browser MVP

- Add self-hosted Steel template and gateway adapter.
- Verify start, navigate, extract text, screenshot, live URL, and release.
- Ensure browser session is per task.

### Phase 4: operator and agent-pod integration

- Operator provisions tool sessions for tool-using AgentTasks.
- Agent-pod exposes browser/code tools through the gateway provider.
- Capability token binds calls to task/session/tool.

### Phase 5: safety and observability

- Add kill switches, backoff, session caps, cleanup controller, and Workbench read surfaces.
- Add Langfuse/tool span output and gateway recent-session API.

### Phase 6: useful UAT

- Ship `examples/local-agentcore-runtime/`.
- Run the web regression investigator against live Workbench/Gateway.
- Capture evidence pack and verify no runaway sessions/tasks.

## 12. Acceptance criteria

- [ ] `@kagent/tool-gateway` exposes browser and code tools over HTTP and MCP-compatible schemas.
- [ ] Every tool-using AgentTask gets its own browser/code sessions; no sessions are shared between parent/child/sibling tasks.
- [ ] Tool sandboxes receive only the env allowlist in section 6.1.
- [ ] Tool sandboxes do not mount ServiceAccount tokens or host paths.
- [ ] Browser runtime runs self-hosted Steel in-cluster, not Fly.io.
- [ ] Code runtime runs in-cluster through agent-sandbox or a compatible Kubernetes sandbox template.
- [ ] MCP/ad hoc tools can be attached through the gateway without inheriting gateway env.
- [ ] Failure backoff prevents repeated bad starts from creating unbounded pods.
- [ ] Kill switches can stop new browser/code sessions and terminate existing sessions.
- [ ] A real AgentTask completes the web regression investigator UAT using both browser and code tools.
- [ ] UAT evidence proves session cleanup, bounded LLM/tool calls, artifacts, and a useful final report.

## 13. Non-goals

- Building a new domain-specific job-application agent.
- Replacing Hermes, OpenClaw, project_tracker, or SeekArc.
- Giving agents SSH-equivalent host access.
- Letting MCP servers run with ambient gateway env.
- Exposing arbitrary Kubernetes CLI access inside code-runner.
- Building a new browser automation engine; Steel/Chrome/Playwright/CDP are the browser stack.
- Building a new sandbox controller; agent-sandbox is the Kubernetes sandbox substrate.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Steel image needs privileges that conflict with strict sandbox policy | Start with Steel in an agent-sandbox template using the least privileges that actually boot Chrome; document any exception as a chart value and fail closed by default. |
| Per-task browser sandboxes are cold and slow | Add `SandboxWarmPool` after measuring; do not share browser sessions to hide cold start. |
| MCP servers become a new env exfiltration path | Run MCP servers as remote services or subprocesses in their own tool sandbox with explicit env allowlist. |
| Agents loop on failed browser/code calls | Tool retry budgets and model loop budget are separate; exhausted tool budget returns a terminal tool-unavailable error. |
| UAT uses credentials | Prefer public/internal pages first; if credentials are needed, route through credential broker and never return secret values to the LLM. |
| Runtime plane becomes another hidden cluster dependency | Workbench and gateway expose session state, caps, and pause status before write controls expand. |

## 15. Source links

- AWS AgentCore Code Interpreter docs: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html`
- AWS AgentCore code execution docs: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-execute-code.html`
- AWS AgentCore file operation docs: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-file-operations.html`
- AWS AgentCore Browser quickstart: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-quickstart.html`
- Agent Sandbox docs: `https://agent-sandbox.sigs.k8s.io/docs/`
- Steel sessions overview: `https://docs.steel.dev/overview/sessions-api/overview`
- Steel session lifecycle: `https://docs.steel.dev/overview/sessions-api/session-lifecycle`
- Steel self-hosting Docker docs: `https://docs.steel.dev/overview/self-hosting/docker`
- Steel Playwright integration: `https://docs.steel.dev/integrations/playwright`
