# Local AgentCore Runtime Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a K3s-native runtime plane where each tool-using AgentTask gets isolated browser and code-runner sessions, with no ambient env bleed, bounded retries, kill switches, MCP/ad hoc hooks, and a useful UAT agent that uses both tools.

**Architecture:** Add shared DTO contracts, a new `@kagent/tool-gateway` package, an agent-pod gateway provider, operator/chart wiring for per-task runtime sessions, self-hosted Steel browser support, and an example UAT bundle. The gateway is the only component that manages tool sessions; sandboxes stay dumb and receive only explicit env allowlists.

**Tech Stack:** TypeScript, Node 22, Vitest, kagent ToolProvider interfaces, Kubernetes client types, Helm charts, agent-sandbox CRDs, Steel Browser CDP/HTTP API.

---

## File Structure

Create:

- `packages/dto/src/tool-session.ts` - shared runtime DTOs, env allowlist constants, session ownership helpers, tool schema descriptors.
- `packages/dto/src/tool-session.test.ts` - tests for env filtering, ownership keys, tool names, schemas, and forbidden env detection.
- `packages/tool-gateway/package.json` - workspace package metadata.
- `packages/tool-gateway/tsconfig.json` - package TS config.
- `packages/tool-gateway/vitest.config.ts` - package Vitest config.
- `packages/tool-gateway/src/index.ts` - public exports.
- `packages/tool-gateway/src/env-policy.ts` - env allowlist and denylist enforcement.
- `packages/tool-gateway/src/env-policy.test.ts` - env policy tests.
- `packages/tool-gateway/src/session-manager.ts` - in-memory session registry used by local and fake K8s adapters.
- `packages/tool-gateway/src/session-manager.test.ts` - session isolation, ownership, TTL, and kill switch tests.
- `packages/tool-gateway/src/code-runner.ts` - dumb local code-runner implementation used for tests and dev.
- `packages/tool-gateway/src/code-runner.test.ts` - file, command, timeout, and stop-task tests.
- `packages/tool-gateway/src/http-server.ts` - minimal HTTP API for code/browser tool invocation.
- `packages/tool-gateway/src/http-server.test.ts` - route and auth/ownership tests.
- `packages/tool-gateway/src/browser-steel.ts` - Steel adapter with fakeable fetch.
- `packages/tool-gateway/src/browser-steel.test.ts` - session create, navigate, screenshot, live URL, and release tests with fake Steel API.
- `packages/agent-pod/src/tool-gateway-provider.ts` - ToolProvider that forwards `browser.*` and `code_interpreter.*` calls to the gateway.
- `packages/agent-pod/src/tool-gateway-provider.test.ts` - descriptor and execution tests.
- `packages/operator/src/tool-runtime/config.ts` - operator runtime-plane config parsing.
- `packages/operator/src/tool-runtime/config.test.ts` - config and kill-switch parsing tests.
- `packages/operator/src/tool-runtime/session-labels.ts` - labels/annotations for session ownership.
- `packages/operator/src/tool-runtime/session-labels.test.ts` - ownership label tests.
- `packages/operator/charts/kagent-operator/templates/tool-gateway-deployment.yaml` - optional gateway Deployment.
- `packages/operator/charts/kagent-operator/templates/tool-gateway-service.yaml` - optional gateway Service.
- `packages/operator/charts/kagent-operator/templates/tool-runtime-rbac.yaml` - RBAC for sandbox claims and gateway.
- `packages/operator/charts/kagent-operator/templates/tool-runtime-networkpolicy.yaml` - default-deny runtime policies.
- `packages/operator/charts/kagent-operator/templates/tool-runtime-sandbox-templates.yaml` - agent-sandbox templates for code runner and Steel browser.
- `examples/local-agentcore-runtime/README.md` - UAT description and expected evidence.
- `examples/local-agentcore-runtime/kustomization.yaml` - example bundle entrypoint.
- `examples/local-agentcore-runtime/agent.yaml` - browser+code investigator Agent.
- `examples/local-agentcore-runtime/task.yaml` - useful UAT AgentTask.

Modify:

- `packages/dto/src/index.ts` - export tool-session DTOs.
- `package.json` - no change expected; workspace glob already covers `packages/*`.
- `packages/agent-pod/package.json` - add `@kagent/tool-gateway` if provider imports shared gateway client helpers.
- `packages/agent-pod/src/env.ts` - parse gateway URL and tool-runtime flags.
- `packages/agent-pod/src/runner.ts` - append gateway provider when Agent declares browser/code tools.
- `packages/operator/package.json` - no change expected unless runtime helper imports a new workspace dep.
- `packages/operator/charts/kagent-operator/values.yaml` - add `toolRuntime` values.
- `packages/operator/charts/kagent-operator/templates/deployment.yaml` - project operator tool-runtime env.
- `packages/operator/scripts/check-runtime-class-render.sh` or add a sibling render script - include tool-runtime render checks.

## Milestone Sequencing

1. DTO/session contracts.
2. Tool gateway package with env policy and code-runner local backend.
3. HTTP surface and agent-pod provider.
4. Browser Steel adapter.
5. Operator and chart wiring.
6. Safety controls and observability.
7. UAT bundle and live verification.

## Task 1: DTO Contracts For Tool Sessions

**Files:**

- Create: `packages/dto/src/tool-session.ts`
- Create: `packages/dto/src/tool-session.test.ts`
- Modify: `packages/dto/src/index.ts`

- [ ] **Step 1: Write failing DTO tests**

Create `packages/dto/src/tool-session.test.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  CODE_INTERPRETER_TOOL_NAMES,
  DEFAULT_TOOL_SESSION_ENV,
  FORBIDDEN_TOOL_SESSION_ENV_KEYS,
  TOOL_KINDS,
  buildToolSessionKey,
  filterToolSessionEnv,
  isCodeInterpreterTool,
  isForbiddenToolSessionEnvKey,
  isToolKind,
} from './tool-session.js';

describe('tool-session DTO contracts', () => {
  it('recognizes only browser and code_interpreter as tool kinds', () => {
    expect(TOOL_KINDS).toEqual(['browser', 'code_interpreter']);
    expect(isToolKind('browser')).toBe(true);
    expect(isToolKind('code_interpreter')).toBe(true);
    expect(isToolKind('shell')).toBe(false);
  });

  it('builds a task-scoped session key that includes tenant, namespace, task uid, tool kind, and session id', () => {
    expect(
      buildToolSessionKey({
        tenant: 'homelab',
        namespace: 'kagent-draft',
        agentTaskUid: 'task-123',
        toolKind: 'browser',
        sessionId: 'sess-1',
      }),
    ).toBe('homelab/kagent-draft/task-123/browser/sess-1');
  });

  it('declares AgentCore-shaped code interpreter tools', () => {
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.execute_code');
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.write_files');
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.stop_task');
    expect(isCodeInterpreterTool('code_interpreter.execute_command')).toBe(true);
    expect(isCodeInterpreterTool('browser.goto')).toBe(false);
  });

  it('filters sandbox env to the explicit allowlist and never forwards ambient secrets', () => {
    const env = filterToolSessionEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/chris',
        OPENAI_API_KEY: 'secret',
        CLOUDFLARE_API_TOKEN: 'secret',
        KAGENT_TASK_UID: 'wrong',
        EXTRA: 'nope',
      },
      {
        taskUid: 'task-123',
        agentName: 'agent',
        namespace: 'kagent-draft',
        sessionId: 'sess-1',
        toolKind: 'code_interpreter',
      },
    );

    expect(env).toEqual({
      ...DEFAULT_TOOL_SESSION_ENV,
      KAGENT_TASK_UID: 'task-123',
      KAGENT_AGENT_NAME: 'agent',
      KAGENT_NAMESPACE: 'kagent-draft',
      KAGENT_TOOL_SESSION_ID: 'sess-1',
      KAGENT_TOOL_KIND: 'code_interpreter',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(env).not.toHaveProperty('EXTRA');
  });

  it('catches forbidden env keys case-insensitively', () => {
    expect(FORBIDDEN_TOOL_SESSION_ENV_KEYS).toContain('KUBECONFIG');
    expect(isForbiddenToolSessionEnvKey('openai_api_key')).toBe(true);
    expect(isForbiddenToolSessionEnvKey('KUBERNETES_SERVICE_HOST')).toBe(true);
    expect(isForbiddenToolSessionEnvKey('PATH')).toBe(false);
  });
});
```

- [ ] **Step 2: Run DTO test and verify RED**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/dto test -- src/tool-session.test.ts
```

Expected: FAIL because `packages/dto/src/tool-session.ts` does not exist.

- [ ] **Step 3: Implement DTO contracts**

Create `packages/dto/src/tool-session.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export const TOOL_KINDS = ['browser', 'code_interpreter'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const CODE_INTERPRETER_TOOL_NAMES = [
  'code_interpreter.start_session',
  'code_interpreter.execute_code',
  'code_interpreter.execute_command',
  'code_interpreter.start_command',
  'code_interpreter.read_files',
  'code_interpreter.write_files',
  'code_interpreter.list_files',
  'code_interpreter.stop_task',
  'code_interpreter.terminate_session',
] as const;
export type CodeInterpreterToolName = (typeof CODE_INTERPRETER_TOOL_NAMES)[number];

export const BROWSER_TOOL_NAMES = [
  'browser.start_session',
  'browser.goto',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.wait_for',
  'browser.screenshot',
  'browser.extract_text',
  'browser.cdp_url',
  'browser.live_view_url',
  'browser.recording_url',
  'browser.terminate_session',
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type ToolRuntimeToolName = CodeInterpreterToolName | BrowserToolName;

export const DEFAULT_TOOL_SESSION_ENV = {
  HOME: '/workspace',
  TMPDIR: '/tmp',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
} as const;

export const FORBIDDEN_TOOL_SESSION_ENV_KEYS = [
  'OPENAI_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'KUBECONFIG',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'GITHUB_TOKEN',
  'LANGFUSE_SECRET_KEY',
  'DATABASE_URL',
] as const;

export interface ToolSessionIdentity {
  readonly tenant: string;
  readonly namespace: string;
  readonly agentTaskUid: string;
  readonly toolKind: ToolKind;
  readonly sessionId: string;
}

export interface ToolSessionEnvContext {
  readonly taskUid: string;
  readonly agentName: string;
  readonly namespace: string;
  readonly sessionId: string;
  readonly toolKind: ToolKind;
}

export interface ToolSessionRecord extends ToolSessionIdentity {
  readonly agentName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt?: string;
  readonly status: 'starting' | 'ready' | 'terminating' | 'terminated' | 'failed';
  readonly sandboxName?: string;
  readonly podName?: string;
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value);
}

export function isCodeInterpreterTool(value: unknown): value is CodeInterpreterToolName {
  return (
    typeof value === 'string' &&
    (CODE_INTERPRETER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isBrowserTool(value: unknown): value is BrowserToolName {
  return typeof value === 'string' && (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isToolRuntimeTool(value: unknown): value is ToolRuntimeToolName {
  return isCodeInterpreterTool(value) || isBrowserTool(value);
}

export function isForbiddenToolSessionEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (FORBIDDEN_TOOL_SESSION_ENV_KEYS as readonly string[]).includes(normalized);
}

export function buildToolSessionKey(identity: ToolSessionIdentity): string {
  return [
    identity.tenant,
    identity.namespace,
    identity.agentTaskUid,
    identity.toolKind,
    identity.sessionId,
  ].join('/');
}

export function filterToolSessionEnv(
  _ambientEnv: Readonly<Record<string, string | undefined>>,
  context: ToolSessionEnvContext,
): Record<string, string> {
  return {
    ...DEFAULT_TOOL_SESSION_ENV,
    KAGENT_TASK_UID: context.taskUid,
    KAGENT_AGENT_NAME: context.agentName,
    KAGENT_NAMESPACE: context.namespace,
    KAGENT_TOOL_SESSION_ID: context.sessionId,
    KAGENT_TOOL_KIND: context.toolKind,
  };
}
```

Modify `packages/dto/src/index.ts`:

```typescript
export type {
  BrowserToolName,
  CodeInterpreterToolName,
  ToolKind,
  ToolRuntimeToolName,
  ToolSessionEnvContext,
  ToolSessionIdentity,
  ToolSessionRecord,
} from './tool-session.js';
export {
  BROWSER_TOOL_NAMES,
  CODE_INTERPRETER_TOOL_NAMES,
  DEFAULT_TOOL_SESSION_ENV,
  FORBIDDEN_TOOL_SESSION_ENV_KEYS,
  TOOL_KINDS,
  buildToolSessionKey,
  filterToolSessionEnv,
  isBrowserTool,
  isCodeInterpreterTool,
  isForbiddenToolSessionEnvKey,
  isToolKind,
  isToolRuntimeTool,
} from './tool-session.js';
```

- [ ] **Step 4: Run DTO tests and typecheck**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/dto test -- src/tool-session.test.ts
pnpm -F @kagent/dto typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit DTO contracts**

```bash
git add packages/dto/src/tool-session.ts packages/dto/src/tool-session.test.ts packages/dto/src/index.ts
git commit -m "feat(dto): add tool runtime session contracts"
```

## Task 2: Tool Gateway Package Scaffold

**Files:**

- Create: `packages/tool-gateway/package.json`
- Create: `packages/tool-gateway/tsconfig.json`
- Create: `packages/tool-gateway/vitest.config.ts`
- Create: `packages/tool-gateway/src/index.ts`
- Create: `packages/tool-gateway/src/env-policy.ts`
- Create: `packages/tool-gateway/src/env-policy.test.ts`

- [ ] **Step 1: Write failing env-policy tests**

Create `packages/tool-gateway/src/env-policy.test.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { buildSandboxEnv, findForbiddenEnvKeys } from './env-policy.js';

describe('tool gateway env policy', () => {
  it('builds a minimal sandbox env without ambient process variables', () => {
    const env = buildSandboxEnv({
      ambientEnv: {
        PATH: '/opt/homebrew/bin',
        HOME: '/Users/chris',
        OPENAI_API_KEY: 'secret',
        DATABASE_URL: 'postgres://secret',
      },
      context: {
        taskUid: 'task-1',
        agentName: 'investigator',
        namespace: 'kagent-draft',
        sessionId: 'code-1',
        toolKind: 'code_interpreter',
      },
    });

    expect(env).toEqual({
      HOME: '/workspace',
      TMPDIR: '/tmp',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      KAGENT_TASK_UID: 'task-1',
      KAGENT_AGENT_NAME: 'investigator',
      KAGENT_NAMESPACE: 'kagent-draft',
      KAGENT_TOOL_SESSION_ID: 'code-1',
      KAGENT_TOOL_KIND: 'code_interpreter',
    });
  });

  it('reports forbidden keys before launching a sandbox', () => {
    expect(
      findForbiddenEnvKeys({
        OPENAI_API_KEY: 'x',
        openai_api_key: 'x',
        PATH: '/bin',
        KUBECONFIG: '/tmp/config',
      }),
    ).toEqual(['OPENAI_API_KEY', 'openai_api_key', 'KUBECONFIG']);
  });
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/env-policy.test.ts
```

Expected: FAIL because `@kagent/tool-gateway` does not exist.

- [ ] **Step 3: Scaffold the package**

Create `packages/tool-gateway/package.json`:

```json
{
  "name": "@kagent/tool-gateway",
  "version": "0.0.0",
  "private": true,
  "description": "Local tool runtime gateway for per-AgentTask browser and code-runner sessions.",
  "license": "MIT",
  "author": "Chris Knuteson <chris@ctkadvisors.net>",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p . --noEmit",
    "lint": "eslint . --max-warnings 0",
    "test": "vitest run --passWithNoTests",
    "test:coverage": "vitest run --coverage --passWithNoTests",
    "build": "tsc -p .",
    "clean": "rm -rf dist .tsbuildinfo"
  },
  "files": ["dist", "src"],
  "dependencies": {
    "@kagent/agent-loop": "workspace:*",
    "@kagent/dto": "workspace:*"
  },
  "devDependencies": {
    "tsx": "4.21.0"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Create `packages/tool-gateway/tsconfig.json` matching the other package configs.

Create `packages/tool-gateway/vitest.config.ts` matching `packages/http-tool-provider/vitest.config.ts`.

Create `packages/tool-gateway/src/index.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export { buildSandboxEnv, findForbiddenEnvKeys } from './env-policy.js';
```

- [ ] **Step 4: Implement env policy**

Create `packages/tool-gateway/src/env-policy.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import {
  filterToolSessionEnv,
  isForbiddenToolSessionEnvKey,
  type ToolSessionEnvContext,
} from '@kagent/dto';

export interface BuildSandboxEnvOptions {
  readonly ambientEnv: Readonly<Record<string, string | undefined>>;
  readonly context: ToolSessionEnvContext;
}

export function buildSandboxEnv(options: BuildSandboxEnvOptions): Record<string, string> {
  return filterToolSessionEnv(options.ambientEnv, options.context);
}

export function findForbiddenEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(env).filter((key) => isForbiddenToolSessionEnvKey(key));
}
```

- [ ] **Step 5: Run package tests and typecheck**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/env-policy.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit package scaffold**

```bash
git add packages/tool-gateway
git commit -m "feat(tool-gateway): add package scaffold and env policy"
```

## Task 3: Session Manager With Isolation And Kill Switches

**Files:**

- Create: `packages/tool-gateway/src/session-manager.ts`
- Create: `packages/tool-gateway/src/session-manager.test.ts`
- Modify: `packages/tool-gateway/src/index.ts`

- [ ] **Step 1: Write failing session-manager tests**

Create `packages/tool-gateway/src/session-manager.test.ts`:

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { InMemoryToolSessionManager } from './session-manager.js';

describe('InMemoryToolSessionManager', () => {
  it('creates separate sessions for sibling tasks even when tool kind matches', () => {
    const manager = new InMemoryToolSessionManager({ now: () => new Date('2026-06-08T12:00:00Z') });
    const a = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'code_interpreter',
      ttlSeconds: 60,
    });
    const b = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-b',
      agentName: 'agent-b',
      toolKind: 'code_interpreter',
      ttlSeconds: 60,
    });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(manager.get(a)?.agentTaskUid).toBe('task-a');
    expect(manager.get(b)?.agentTaskUid).toBe('task-b');
  });

  it('rejects lookup when ownership fields do not match', () => {
    const manager = new InMemoryToolSessionManager({ now: () => new Date('2026-06-08T12:00:00Z') });
    const session = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'browser',
      ttlSeconds: 60,
    });

    expect(
      manager.get({
        ...session,
        agentTaskUid: 'task-b',
      }),
    ).toBeNull();
  });

  it('stops admitting sessions while paused', () => {
    const manager = new InMemoryToolSessionManager({ now: () => new Date('2026-06-08T12:00:00Z') });
    manager.setPaused(true);

    expect(() =>
      manager.start({
        tenant: 'homelab',
        namespace: 'kagent',
        agentTaskUid: 'task-a',
        agentName: 'agent-a',
        toolKind: 'browser',
        ttlSeconds: 60,
      }),
    ).toThrow(/tool_runtime_paused/);
  });

  it('marks terminated sessions and keeps them unavailable for tool calls', () => {
    const manager = new InMemoryToolSessionManager({ now: () => new Date('2026-06-08T12:00:00Z') });
    const session = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'browser',
      ttlSeconds: 60,
    });
    manager.terminate(session);

    expect(manager.get(session)?.status).toBe('terminated');
    expect(manager.requireReady(session)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/session-manager.test.ts
```

Expected: FAIL because `session-manager.ts` does not exist.

- [ ] **Step 3: Implement session manager**

Create `packages/tool-gateway/src/session-manager.ts` with:

- `StartToolSessionInput`
- `ToolSessionLookup`
- `InMemoryToolSessionManager`
- `start()`
- `get()`
- `requireReady()`
- `terminate()`
- `setPaused()`

Required behavior:

- session id generated as `${toolKind}-${counter}`
- key is `buildToolSessionKey()`
- `start()` throws `tool_runtime_paused` when paused
- `get()` returns `null` on ownership mismatch or missing key
- `requireReady()` returns `null` unless status is `ready`
- `terminate()` changes status to `terminated`

Implementation sketch:

```typescript
import { buildToolSessionKey, type ToolKind, type ToolSessionIdentity, type ToolSessionRecord } from '@kagent/dto';

export interface StartToolSessionInput {
  readonly tenant: string;
  readonly namespace: string;
  readonly agentTaskUid: string;
  readonly agentName: string;
  readonly toolKind: ToolKind;
  readonly ttlSeconds: number;
}

export type ToolSessionLookup = ToolSessionIdentity;

export class InMemoryToolSessionManager {
  private readonly sessions = new Map<string, ToolSessionRecord>();
  private counter = 0;
  private paused = false;
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  start(input: StartToolSessionInput): ToolSessionIdentity {
    if (this.paused) throw new Error('tool_runtime_paused');
    this.counter += 1;
    const sessionId = `${input.toolKind}-${String(this.counter)}`;
    const created = this.now();
    const expires = new Date(created.getTime() + input.ttlSeconds * 1000);
    const identity = {
      tenant: input.tenant,
      namespace: input.namespace,
      agentTaskUid: input.agentTaskUid,
      toolKind: input.toolKind,
      sessionId,
    };
    this.sessions.set(buildToolSessionKey(identity), {
      ...identity,
      agentName: input.agentName,
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString(),
      status: 'ready',
    });
    return identity;
  }

  get(lookup: ToolSessionLookup): ToolSessionRecord | null {
    return this.sessions.get(buildToolSessionKey(lookup)) ?? null;
  }

  requireReady(lookup: ToolSessionLookup): ToolSessionRecord | null {
    const record = this.get(lookup);
    return record?.status === 'ready' ? record : null;
  }

  terminate(lookup: ToolSessionLookup): ToolSessionRecord | null {
    const record = this.get(lookup);
    if (record === null) return null;
    const next = { ...record, status: 'terminated' as const };
    this.sessions.set(buildToolSessionKey(lookup), next);
    return next;
  }
}
```

Export from `packages/tool-gateway/src/index.ts`.

- [ ] **Step 4: Run tests and typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/session-manager.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit session manager**

```bash
git add packages/tool-gateway/src/session-manager.ts packages/tool-gateway/src/session-manager.test.ts packages/tool-gateway/src/index.ts
git commit -m "feat(tool-gateway): add isolated session manager"
```

## Task 4: Dumb Local Code Runner

**Files:**

- Create: `packages/tool-gateway/src/code-runner.ts`
- Create: `packages/tool-gateway/src/code-runner.test.ts`
- Modify: `packages/tool-gateway/src/index.ts`

- [ ] **Step 1: Write failing code-runner tests**

Create tests that prove:

- `writeFiles()` refuses absolute paths and `..`.
- `readFiles()` reads only workspace files.
- `executeCommand()` allows `node -e "console.log('ok')"` and captures stdout.
- `executeCommand()` denies `kubectl`.
- `executeCommand()` returns timeout error when command exceeds timeout.
- `executeCode({ language: 'python' })` writes a temp file and runs `python3`.

Use `mkdtemp()` under `node:os.tmpdir()` and clean up with `rm(..., { recursive: true, force: true })`.

- [ ] **Step 2: Run test and verify RED**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/code-runner.test.ts
```

Expected: FAIL because `code-runner.ts` does not exist.

- [ ] **Step 3: Implement code-runner**

Implement:

- `LocalCodeRunner`
- `writeFiles(files)`
- `readFiles(paths)`
- `listFiles()`
- `executeCommand({ command, args, timeoutMs })`
- `executeCode({ language, code, timeoutMs })`
- path resolver that refuses paths outside workspace
- command allowlist from the spec
- command denylist for `kubectl`, `helm`, `docker`, `podman`, `ssh`, `scp`, `sudo`, `mount`

Use `node:child_process` `spawn` with `cwd` set to the workspace and `env` supplied by `buildSandboxEnv()`.

- [ ] **Step 4: Run tests and typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/code-runner.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit code-runner**

```bash
git add packages/tool-gateway/src/code-runner.ts packages/tool-gateway/src/code-runner.test.ts packages/tool-gateway/src/index.ts
git commit -m "feat(tool-gateway): add dumb local code runner"
```

## Task 5: Gateway HTTP Tool Surface

**Files:**

- Create: `packages/tool-gateway/src/http-server.ts`
- Create: `packages/tool-gateway/src/http-server.test.ts`
- Modify: `packages/tool-gateway/src/index.ts`

- [ ] **Step 1: Write failing HTTP tests**

Test:

- `POST /v1/tools/code_interpreter.start_session` returns a session identity.
- `POST /v1/tools/code_interpreter.write_files` writes through the matching session.
- wrong `agentTaskUid` gets 403.
- paused runtime returns `tool_runtime_paused`.
- unknown tool gets 404.

- [ ] **Step 2: Run test and verify RED**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/http-server.test.ts
```

Expected: FAIL because `http-server.ts` does not exist.

- [ ] **Step 3: Implement HTTP server factory**

Use Node's built-in `node:http`. Export `createToolGatewayServer(options)` returning `http.Server`.

Request envelope:

```typescript
interface ToolGatewayRequest {
  readonly tenant: string;
  readonly namespace: string;
  readonly agentTaskUid: string;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly arguments?: Record<string, unknown>;
}
```

Response envelope:

```typescript
interface ToolGatewayResponse {
  readonly isError: boolean;
  readonly content: unknown;
  readonly metadata?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/http-server.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit HTTP surface**

```bash
git add packages/tool-gateway/src/http-server.ts packages/tool-gateway/src/http-server.test.ts packages/tool-gateway/src/index.ts
git commit -m "feat(tool-gateway): expose code tools over HTTP"
```

## Task 6: Agent-Pod Gateway Provider

**Files:**

- Create: `packages/agent-pod/src/tool-gateway-provider.ts`
- Create: `packages/agent-pod/src/tool-gateway-provider.test.ts`
- Modify: `packages/agent-pod/src/env.ts`
- Modify: `packages/agent-pod/src/runner.ts`

- [ ] **Step 1: Write failing provider tests**

Test:

- descriptors include only browser/code tools declared by `Agent.spec.tools`.
- `executeTool()` posts to gateway with task UID, namespace, agent name, and args.
- non-2xx gateway responses become `ToolResult{ isError: true }`.
- missing gateway URL fails fast when browser/code tool is declared.

- [ ] **Step 2: Run test and verify RED**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/agent-pod test -- src/tool-gateway-provider.test.ts
```

Expected: FAIL because provider file does not exist.

- [ ] **Step 3: Implement provider**

Implement `ToolGatewayProvider implements ToolProvider`.

Constructor args:

```typescript
interface ToolGatewayProviderOptions {
  readonly baseUrl: string;
  readonly tenant?: string;
  readonly namespace: string;
  readonly taskUid: string;
  readonly agentName: string;
  readonly toolNames: readonly ToolRuntimeToolName[];
  readonly fetch?: typeof globalThis.fetch;
}
```

`executeTool()` posts to:

```text
POST {baseUrl}/v1/tools/{call.name}
```

with JSON body:

```json
{
  "tenant": "default",
  "namespace": "...",
  "agentTaskUid": "...",
  "agentName": "...",
  "arguments": {}
}
```

- [ ] **Step 4: Wire runner**

Add `toolGatewayBaseUrl?: string` to `PodConfig` parsing.

In `resolveToolProviders()`, when `Agent.spec.tools` contains `browser.*` or `code_interpreter.*`, append `ToolGatewayProvider`. Do not register those names through `resolveBuiltinTools()`.

- [ ] **Step 5: Run tests and typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/agent-pod test -- src/tool-gateway-provider.test.ts src/runner.test.ts src/env.test.ts
pnpm -F @kagent/agent-pod typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit agent-pod provider**

```bash
git add packages/agent-pod/src/tool-gateway-provider.ts packages/agent-pod/src/tool-gateway-provider.test.ts packages/agent-pod/src/env.ts packages/agent-pod/src/runner.ts packages/agent-pod/package.json
git commit -m "feat(agent-pod): route runtime tools through gateway"
```

## Task 7: Steel Browser Adapter

**Files:**

- Create: `packages/tool-gateway/src/browser-steel.ts`
- Create: `packages/tool-gateway/src/browser-steel.test.ts`
- Modify: `packages/tool-gateway/src/http-server.ts`
- Modify: `packages/tool-gateway/src/index.ts`

- [ ] **Step 1: Write failing Steel adapter tests**

Test with fake `fetch`:

- `startSession()` calls Steel session create API and stores websocket/live URLs.
- `goto()` calls the session action path.
- `screenshot()` returns an artifact-like metadata object.
- `terminateSession()` calls release and marks session terminated.

- [ ] **Step 2: Run test and verify RED**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/browser-steel.test.ts
```

Expected: FAIL because adapter file does not exist.

- [ ] **Step 3: Implement fakeable adapter**

Implement a narrow `SteelBrowserRuntime` that takes:

```typescript
interface SteelBrowserRuntimeOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}
```

The adapter must not import Playwright; Playwright/CDP consumers use `browser.cdp_url` from the session metadata. The gateway should stay a thin HTTP action router.

- [ ] **Step 4: Add browser routes**

Add browser tool cases to `http-server.ts`:

- `browser.start_session`
- `browser.goto`
- `browser.extract_text`
- `browser.screenshot`
- `browser.live_view_url`
- `browser.cdp_url`
- `browser.terminate_session`

- [ ] **Step 5: Run tests and typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test -- src/browser-steel.test.ts src/http-server.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit browser adapter**

```bash
git add packages/tool-gateway/src/browser-steel.ts packages/tool-gateway/src/browser-steel.test.ts packages/tool-gateway/src/http-server.ts packages/tool-gateway/src/index.ts
git commit -m "feat(tool-gateway): add self-hosted Steel browser adapter"
```

## Task 8: Operator And Chart Wiring

**Files:**

- Create: `packages/operator/src/tool-runtime/config.ts`
- Create: `packages/operator/src/tool-runtime/config.test.ts`
- Create: `packages/operator/src/tool-runtime/session-labels.ts`
- Create: `packages/operator/src/tool-runtime/session-labels.test.ts`
- Modify: `packages/operator/src/main.ts`
- Modify: `packages/operator/src/job-spec.ts`
- Modify: `packages/operator/charts/kagent-operator/values.yaml`
- Modify: `packages/operator/charts/kagent-operator/templates/deployment.yaml`
- Create chart templates listed in File Structure.

- [ ] **Step 1: Write failing operator config tests**

Test:

- defaults have runtime disabled.
- `KAGENT_TOOL_RUNTIME_ENABLED=true` enables gateway URL projection.
- `maxSessions=0` is admission drain.
- browser/code kill switches parse independently.

- [ ] **Step 2: Run RED**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/operator test -- src/tool-runtime/config.test.ts
```

Expected: FAIL because file does not exist.

- [ ] **Step 3: Implement runtime config and labels**

Config shape:

```typescript
interface ToolRuntimeConfig {
  readonly enabled: boolean;
  readonly browserEnabled: boolean;
  readonly codeEnabled: boolean;
  readonly gatewayBaseUrl?: string;
  readonly maxSessions: number;
}
```

Labels:

```text
kagent.knuteson.io/tool-session=true
kagent.knuteson.io/tool-kind=<browser|code_interpreter>
kagent.knuteson.io/task-uid=<uid>
kagent.knuteson.io/agent=<agent>
```

- [ ] **Step 4: Render chart tests**

Add chart values:

```yaml
toolRuntime:
  enabled: false
  namespace: kagent-runtime
  gateway:
    image:
      repository: ghcr.io/ctkadvisors/kagent-tool-gateway
      tag: ''
      pullPolicy: IfNotPresent
    servicePort: 8088
  maxSessions: 10
  browser:
    enabled: true
    steelImage: ghcr.io/steel-dev/steel-browser:latest
  code:
    enabled: true
    image: ghcr.io/ctkadvisors/kagent-code-runner:latest
```

Render command:

```bash
helm template kagent-operator packages/operator/charts/kagent-operator --set toolRuntime.enabled=true --set toolRuntime.browser.enabled=true --set toolRuntime.code.enabled=true >/tmp/kagent-tool-runtime.yaml
rg "kind: Deployment|agent-tool-gateway|SandboxTemplate|automountServiceAccountToken: false|hostPath" /tmp/kagent-tool-runtime.yaml
```

Expected: gateway deployment and sandbox templates render; no `hostPath` occurs.

- [ ] **Step 5: Commit operator/chart wiring**

```bash
git add packages/operator/src/tool-runtime packages/operator/src/main.ts packages/operator/src/job-spec.ts packages/operator/charts/kagent-operator
git commit -m "feat(operator): wire local tool runtime plane"
```

## Task 9: Safety Controls And Observability

**Files:**

- Modify: `packages/tool-gateway/src/session-manager.ts`
- Modify: `packages/tool-gateway/src/http-server.ts`
- Create: `packages/tool-gateway/src/audit.ts`
- Create: `packages/tool-gateway/src/audit.test.ts`
- Modify: `packages/dto/src/tool-session.ts`

- [ ] **Step 1: Add failing tests for backoff and cleanup**

Test:

- failed session starts back off as 5s, 20s, 60s.
- fourth failed start returns `tool_start_budget_exhausted`.
- `terminateByTask(taskUid)` terminates all task sessions.
- `cleanupExpired()` terminates expired sessions.

- [ ] **Step 2: Implement backoff state**

Use an in-memory map keyed by `tenant/namespace/taskUid/toolKind`. Keep this small until a K8s-backed implementation needs persisted state.

- [ ] **Step 3: Add audit event DTOs**

Events:

- `tool_session.started`
- `tool_session.terminated`
- `tool_session.failed`
- `tool_call.completed`
- `tool_runtime.paused`

- [ ] **Step 4: Run tests**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
pnpm -F @kagent/tool-gateway test
pnpm -F @kagent/dto test -- src/tool-session.test.ts
pnpm -F @kagent/tool-gateway typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit safety controls**

```bash
git add packages/tool-gateway packages/dto/src/tool-session.ts packages/dto/src/tool-session.test.ts
git commit -m "feat(tool-gateway): add backoff cleanup and audit events"
```

## Task 10: UAT Example Bundle

**Files:**

- Create: `examples/local-agentcore-runtime/README.md`
- Create: `examples/local-agentcore-runtime/kustomization.yaml`
- Create: `examples/local-agentcore-runtime/agent.yaml`
- Create: `examples/local-agentcore-runtime/task.yaml`

- [ ] **Step 1: Add UAT manifests**

`agent.yaml` must declare:

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: local-agentcore-investigator
  namespace: kagent-draft
spec:
  modelClass: tool-caller-default
  sandboxProfile: strict
  tools:
    - browser.start_session
    - browser.goto
    - browser.extract_text
    - browser.screenshot
    - browser.terminate_session
    - code_interpreter.start_session
    - code_interpreter.write_files
    - code_interpreter.execute_code
    - code_interpreter.read_files
    - code_interpreter.terminate_session
    - write_artifact
  toolRuntime:
    isolation: perTask
    browser:
      templateRef: browser-steel-v1
    code:
      templateRef: code-runner-v1
  systemPrompt: |
    You are an operations investigator. Use browser tools for live UI evidence,
    code tools for grouping and analysis, and write_artifact for the final report.
    Do not invent observations. Terminate browser and code sessions before final.
```

`task.yaml` must ask for the web regression investigator scenario from the spec.

- [ ] **Step 2: Validate manifests render**

```bash
kubectl kustomize examples/local-agentcore-runtime >/tmp/local-agentcore-runtime.yaml
rg "local-agentcore-investigator|browser.start_session|code_interpreter.execute_code" /tmp/local-agentcore-runtime.yaml
```

Expected: both Agent and AgentTask render.

- [ ] **Step 3: Commit UAT bundle**

```bash
git add examples/local-agentcore-runtime
git commit -m "test: add local AgentCore runtime UAT bundle"
```

## Task 11: Live Cluster Verification

**Files:**

- Modify only GitOps manifests in `../new_localai` after kagent image/chart work is built and tagged.

- [ ] **Step 1: Build and tag images**

Use the repo's established image build path. Expected images:

```text
ghcr.io/ctkadvisors/kagent-tool-gateway:<tag>
ghcr.io/ctkadvisors/kagent-agent-pod:<tag>
ghcr.io/ctkadvisors/kagent-operator:<tag>
```

- [ ] **Step 2: Deploy via GitOps**

Update `new_localai` kagent values to enable:

```yaml
toolRuntime:
  enabled: true
  browser:
    enabled: true
  code:
    enabled: true
```

Do not use imperative `kubectl apply` for deployed state.

- [ ] **Step 3: Verify runtime is idle before UAT**

Run:

```bash
kubectl get pods -A | rg "kagent|tool|steel|sandbox"
kubectl get agenttasks -A
```

Expected: no unbounded pending/running tasks; tool gateway ready.

- [ ] **Step 4: Run UAT**

Apply the example through GitOps or a temporary reviewed app. Verify:

```bash
kubectl get agenttasks -n kagent-draft
kubectl logs -n kagent-runtime deploy/kagent-tool-gateway
```

Acceptance:

- task reaches `Completed`
- one browser session
- one code session
- screenshots/artifacts exist
- sessions are terminated
- final report contains real Workbench/Gateway observations
- Cloudflare AI Gateway logs do not show retry spam

- [ ] **Step 5: Capture evidence pack**

Create an evidence directory:

```text
evidence/local-agentcore-runtime/<timestamp>/
```

with:

- task YAML/status
- gateway session log excerpt
- screenshot artifact refs
- final report artifact
- pod list before/after
- gateway request count summary

- [ ] **Step 6: Complete goal audit**

Verify every acceptance criterion in the design spec section 12 against current files, cluster output, and UAT evidence. Only then mark the active goal complete.

## Self-Review Checklist

- Spec coverage: Tasks 1-3 cover DTO/session/env isolation. Tasks 4-7 cover code and browser tools. Task 8 covers K8s-native chart/operator wiring. Task 9 covers backoff, cleanup, and kill switches. Tasks 10-11 cover useful browser+code UAT and evidence.
- Empty-slot scan: every task names concrete files, checks, commands, and expected evidence.
- Type consistency: tool kind names are `browser` and `code_interpreter`; tool names use `browser.*` and `code_interpreter.*`; session ownership fields use tenant, namespace, agentTaskUid, toolKind, sessionId throughout.
