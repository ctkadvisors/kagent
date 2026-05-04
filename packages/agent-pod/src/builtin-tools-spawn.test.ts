/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { AgentSpecEnv } from './env.js';
import {
  buildSpawnToolProvider,
  defaultGenerateChildName,
  DEFAULT_MAX_CONCURRENT_CHILDREN,
} from './builtin-tools-spawn.js';
import type {
  ChildSnapshot,
  ChildTaskCreated,
  ChildTaskInput,
  K8sTaskCreator,
  LiveChildSummary,
  ParentIdentity,
} from './k8s-task-creator.js';

const PARENT: ParentIdentity = {
  uid: 'uid-parent-fixture',
  name: 'parent-task-001',
  namespace: 'kagent-system',
};

/**
 * One Agent CR fixture for getAgentByName. Keys are the Agent's
 * `metadata.name`; values are the labels we want the fake to return.
 * `null` value = simulate "Agent not found" (404 / undefined).
 */
type AgentLabelsMap = Readonly<Record<string, Readonly<Record<string, string>> | null>>;

function makeFakeK8s(opts?: {
  readonly liveChildren?: readonly LiveChildSummary[];
  readonly throwOnCreate?: Error;
  readonly throwOnGetAgent?: Error;
  readonly agents?: AgentLabelsMap;
}): K8sTaskCreator & {
  readonly creates: readonly ChildTaskInput[];
  readonly listLiveCalls: number;
  readonly getAgentCalls: ReadonlyArray<{ namespace: string; name: string }>;
} {
  const creates: ChildTaskInput[] = [];
  const getAgentCalls: { namespace: string; name: string }[] = [];
  let listLiveCalls = 0;
  return {
    creates,
    getAgentCalls,
    get listLiveCalls() {
      return listLiveCalls;
    },
    createChildTask(_parent: ParentIdentity, input: ChildTaskInput): Promise<ChildTaskCreated> {
      if (opts?.throwOnCreate !== undefined) return Promise.reject(opts.throwOnCreate);
      creates.push(input);
      return Promise.resolve({
        name: input.name,
        namespace: PARENT.namespace,
        uid: `uid-${input.name}`,
      });
    },
    listLiveChildren(): Promise<readonly LiveChildSummary[]> {
      listLiveCalls++;
      return Promise.resolve(opts?.liveChildren ?? []);
    },
    listAllChildren(): Promise<readonly ChildSnapshot[]> {
      return Promise.resolve([]);
    },
    getTaskByUid(): Promise<ChildSnapshot | undefined> {
      return Promise.resolve(undefined);
    },
    getAgentByName(
      namespace: string,
      name: string,
    ): Promise<{ readonly labels: Readonly<Record<string, string>> } | undefined> {
      getAgentCalls.push({ namespace, name });
      if (opts?.throwOnGetAgent !== undefined) return Promise.reject(opts.throwOnGetAgent);
      const entry = opts?.agents?.[name];
      if (entry === undefined || entry === null) return Promise.resolve(undefined);
      return Promise.resolve({ labels: entry });
    },
  };
}

function buildSpec(over?: Partial<AgentSpecEnv>): AgentSpecEnv {
  return {
    model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct',
    allowedChildAgents: ['summarizer', 'researcher'],
    maxConcurrentChildren: 5,
    ...over,
  };
}

async function callSpawn(provider: ReturnType<typeof buildSpawnToolProvider>, args: unknown) {
  return provider.executeTool(
    { id: 'call-1', name: 'spawn_child_task', args },
    { abortSignal: new AbortController().signal, runId: 'test-run' },
  );
}

/**
 * Extract the text payload from a ToolResult — InProcessToolProvider
 * returns `content: ContentBlock[]` on success and `content: string`
 * on error. Tests want to assert against either shape.
 */
function resultText(result: { content: unknown }): string {
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const block = result.content[0] as { type?: string; text?: string } | undefined;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  throw new Error('unexpected ToolResult content shape');
}

describe('spawn_child_task', () => {
  it('creates a child with correct manifest shape and returns name/ns/uid', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      generateChildName: () => 'parent-task-001-c-fixedab',
    });

    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'summarize topic X',
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(resultText(result)) as {
      name: string;
      namespace: string;
      uid: string;
    };
    expect(parsed.name).toBe('parent-task-001-c-fixedab');
    expect(parsed.namespace).toBe('kagent-system');
    expect(parsed.uid).toBe('uid-parent-task-001-c-fixedab');
    expect(k8s.creates.length).toBe(1);
    expect(k8s.creates[0]?.targetAgent).toBe('summarizer');
    expect(k8s.creates[0]?.originalUserMessage).toBe('summarize topic X');
  });

  it('refuses spawn when allowedChildAgents is empty (fail-closed)', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({ allowedChildAgents: [] }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(resultText(result)).toContain('no allowedChildAgents');
    expect(k8s.creates.length).toBe(0);
  });

  it('refuses spawn for an agent NOT in allowedChildAgents', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({ allowedChildAgents: ['summarizer'] }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'evil-agent',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(resultText(result)).toContain('not in allowedChildAgents');
  });

  it('refuses single-hop self-spawn even when on the allowlist', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({ allowedChildAgents: ['orchestrator', 'summarizer'] }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'orchestrator',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('immediate cycle');
  });

  it('refuses when concurrent direct children would exceed cap', async () => {
    const k8s = makeFakeK8s({
      liveChildren: [
        { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Pending' },
        { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Dispatched' },
      ],
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({ maxConcurrentChildren: 2 }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('at cap=2');
    expect(k8s.creates.length).toBe(0);
  });

  it('uses DEFAULT_MAX_CONCURRENT_CHILDREN when spec.maxConcurrentChildren is unset', async () => {
    const k8s = makeFakeK8s({
      liveChildren: Array.from({ length: DEFAULT_MAX_CONCURRENT_CHILDREN }, (_, i) => ({
        name: `c${String(i)}`,
        namespace: PARENT.namespace,
        uid: `u${String(i)}`,
        phase: 'Pending' as const,
      })),
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: ['summarizer'],
        maxConcurrentChildren: undefined,
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`at cap=${String(DEFAULT_MAX_CONCURRENT_CHILDREN)}`);
  });

  it("clamps child runConfig.timeoutSeconds to the parent's remaining budget", async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      remainingBudgetSeconds: () => 30, // parent has 30s left
      generateChildName: () => 'parent-task-001-c-clamped',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
      runConfig: { timeoutSeconds: 600 },
    });
    expect(k8s.creates[0]?.runConfig?.timeoutSeconds).toBe(30);
  });

  it('does NOT clamp when child timeout fits within parent budget', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      remainingBudgetSeconds: () => 600,
      generateChildName: () => 'parent-task-001-c-noclamp',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
      runConfig: { timeoutSeconds: 30 },
    });
    expect(k8s.creates[0]?.runConfig?.timeoutSeconds).toBe(30);
  });

  it('rejects missing required args via the JSON schema layer', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
    });
    const result = await callSpawn(provider, {
      // missing originalUserMessage
      agentName: 'summarizer',
    });
    expect(result.isError).toBe(true);
  });

  it('forwards K8s API errors as tool errors', async () => {
    const k8s = makeFakeK8s({
      throwOnCreate: new Error('K8s create failed: connection refused'),
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      generateChildName: () => 'parent-task-001-c-x',
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('connection refused');
  });
});

describe('spawn_child_task — allowedChildTemplates (v0.1.3)', () => {
  it('admits a child whose Agent CR carries a from-template label in allowedChildTemplates', async () => {
    const k8s = makeFakeK8s({
      agents: {
        'summarizer-rust-7f3a2b9c': {
          'kagent.knuteson.io/from-template': 'summarizer',
          'kagent.knuteson.io/managed-by': 'kagent-operator',
        },
      },
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['summarizer'],
      }),
      k8s,
      generateChildName: () => 'parent-task-001-c-tmpl1',
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer-rust-7f3a2b9c',
      originalUserMessage: 'summarize topic X',
    });
    expect(result.isError).not.toBe(true);
    expect(k8s.creates.length).toBe(1);
    expect(k8s.creates[0]?.targetAgent).toBe('summarizer-rust-7f3a2b9c');
    expect(k8s.getAgentCalls).toEqual([
      { namespace: PARENT.namespace, name: 'summarizer-rust-7f3a2b9c' },
    ]);
  });

  it('refuses when the target Agent has no from-template label', async () => {
    const k8s = makeFakeK8s({
      agents: {
        'summarizer-static': {
          'kagent.knuteson.io/managed-by': 'kagent-operator',
          // no from-template label — hand-authored Agent
        },
      },
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['summarizer'],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer-static',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(k8s.getAgentCalls.length).toBe(1);
    expect(k8s.creates.length).toBe(0);
  });

  it('refuses when from-template label value is not in allowedChildTemplates', async () => {
    const k8s = makeFakeK8s({
      agents: {
        'attacker-7f3a2b9c': {
          'kagent.knuteson.io/from-template': 'attacker',
        },
      },
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['summarizer', 'researcher'],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'attacker-7f3a2b9c',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(k8s.getAgentCalls.length).toBe(1);
    expect(k8s.creates.length).toBe(0);
  });

  it('refuses when the target Agent CR does not exist', async () => {
    const k8s = makeFakeK8s({ agents: { 'missing-agent': null } });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['summarizer'],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'missing-agent',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(k8s.getAgentCalls.length).toBe(1);
    expect(k8s.creates.length).toBe(0);
  });

  it('does NOT fetch the Agent CR when allowedChildAgents already matches (cheap path)', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: ['summarizer'],
        allowedChildTemplates: ['summarizer-template'],
      }),
      k8s,
      generateChildName: () => 'parent-task-001-c-cheap',
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).not.toBe(true);
    expect(k8s.getAgentCalls.length).toBe(0);
    expect(k8s.creates.length).toBe(1);
  });

  it('refuses when both allowedChildAgents and allowedChildTemplates are empty/unset', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: [],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('policy_denied');
    expect(resultText(result)).toContain('no allowedChildAgents');
    expect(k8s.getAgentCalls.length).toBe(0);
  });

  it('still rejects self-spawn even when the materialized target matches a template', async () => {
    const k8s = makeFakeK8s({
      agents: {
        orchestrator: {
          'kagent.knuteson.io/from-template': 'orchestrator-tpl',
        },
      },
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['orchestrator-tpl'],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'orchestrator',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('immediate cycle');
    expect(k8s.creates.length).toBe(0);
  });

  it('forwards K8s API errors during getAgentByName as tool errors', async () => {
    const k8s = makeFakeK8s({
      throwOnGetAgent: new Error('K8s get failed: timeout'),
    });
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec({
        allowedChildAgents: [],
        allowedChildTemplates: ['summarizer'],
      }),
      k8s,
    });
    const result = await callSpawn(provider, {
      agentName: 'summarizer-x',
      originalUserMessage: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('timeout');
  });
});

describe('spawn_child_task — traceparent stamping (v0.1.11)', () => {
  it('stamps runConfig.traceparent on the child spec when getTraceparent returns a value', async () => {
    const k8s = makeFakeK8s();
    const tp = '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01';
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      getTraceparent: () => tp,
      generateChildName: () => 'parent-task-001-c-tp',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(k8s.creates).toHaveLength(1);
    expect(k8s.creates[0]?.runConfig?.traceparent).toBe(tp);
  });

  it('omits traceparent when getTraceparent is unset (back-compat)', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      generateChildName: () => 'parent-task-001-c-notp',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(k8s.creates[0]?.runConfig?.traceparent).toBeUndefined();
  });

  it('omits traceparent when getTraceparent returns undefined (OTel disabled)', async () => {
    const k8s = makeFakeK8s();
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      getTraceparent: () => undefined,
      generateChildName: () => 'parent-task-001-c-otelOff',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
    });
    expect(k8s.creates[0]?.runConfig?.traceparent).toBeUndefined();
  });

  it('preserves the parent traceparent alongside other runConfig fields (timeout)', async () => {
    const k8s = makeFakeK8s();
    const tp = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      remainingBudgetSeconds: () => 600,
      getTraceparent: () => tp,
      generateChildName: () => 'parent-task-001-c-mix',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
      runConfig: { timeoutSeconds: 60 },
    });
    expect(k8s.creates[0]?.runConfig).toEqual({
      timeoutSeconds: 60,
      traceparent: tp,
    });
  });

  it('still applies budget clamping when traceparent is also set (independent fields)', async () => {
    const k8s = makeFakeK8s();
    const tp = '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01';
    const provider = buildSpawnToolProvider({
      parent: PARENT,
      parentAgentName: 'orchestrator',
      parentAgentSpec: buildSpec(),
      k8s,
      remainingBudgetSeconds: () => 30,
      getTraceparent: () => tp,
      generateChildName: () => 'parent-task-001-c-mix-clamp',
    });
    await callSpawn(provider, {
      agentName: 'summarizer',
      originalUserMessage: 'hi',
      runConfig: { timeoutSeconds: 600 },
    });
    expect(k8s.creates[0]?.runConfig?.timeoutSeconds).toBe(30); // clamped
    expect(k8s.creates[0]?.runConfig?.traceparent).toBe(tp);
  });
});

describe('defaultGenerateChildName', () => {
  it('produces names matching <parent>-c-<6char> within K8s label cap', () => {
    const name = defaultGenerateChildName('orchestrator-task-001');
    expect(name.startsWith('orchestrator-task-001-c-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(253);
    expect(name.length).toBeGreaterThan('orchestrator-task-001-c-'.length);
  });

  it('truncates oversized parent prefixes to stay under the label cap', () => {
    const longParent = 'a'.repeat(300);
    const name = defaultGenerateChildName(longParent);
    expect(name.length).toBeLessThanOrEqual(253);
  });
});
