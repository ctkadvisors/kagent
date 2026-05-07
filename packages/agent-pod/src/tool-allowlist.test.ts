/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Substrate-tool allowlist cross-check (audit C2.2 HIGH #1 / punchlist H7).
 *
 * The asymmetry the audit flagged: `Agent.spec.tools` was enforced for
 * built-in tool names at boot, but the substrate / blackboard / events
 * providers were appended UNCONDITIONALLY whenever their env triggers
 * fired. An LLM that was jailbroken / mis-prompted to call
 * `spawn_child_task` could reach the global tool federation lookup and
 * succeed even though the Agent spec never listed the tool.
 *
 * The fix: at boot, after substrate providers are stitched in, every
 * tool name they expose must be either (a) explicitly in
 * `Agent.spec.tools` OR (b) admitted by an "implicit-when-X" predicate
 * that proves the Agent declared the matching intent in its schema
 * (allowedChildAgents / allowedChildTemplates for spawn; publishes /
 * capabilityClaims.publish for publish_event; inputs|outputs of
 * kind:'artifact' for read/write_artifact). `get_my_context` is
 * universally admitted as introspection-only.
 *
 * Failing the cross-check is fail-FAST at boot, matching the existing
 * "unknown built-in tool" precedent in `builtin-tools.ts:986`.
 */

import type { ToolInvocationContext, ToolProvider, ToolResult } from '@kagent/agent-loop';
import { describe, expect, it } from 'vitest';

import type { PodConfig } from './env.js';
import { resolveToolProviders } from './runner.js';

const baseConfig: PodConfig = {
  taskId: 'task-uid-1',
  taskName: 't1',
  taskNamespace: 'default',
  agentName: 'researcher',
  agentSpec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    systemPrompt: 'You are a research assistant.',
  },
  taskSpec: {
    payload: { topic: 'k3s' },
    originalUserMessage: 'go',
  },
  litellmBaseUrl: 'http://litellm.test:4000/v1',
  logLevel: 'info',
  traceContentMode: 'preview',
};

/**
 * Build a fake ToolProvider that exposes a fixed set of tool names.
 * Mirrors the `kagent-substrate` / `kagent-blackboard` / `kagent-events`
 * provider shape — one provider, many tool names.
 */
function fakeProvider(id: string, names: readonly string[]): ToolProvider {
  return {
    id,
    describeTools: () => names.map((name) => ({ name, description: '', inputSchema: {} })),
    executeTool: (_: unknown, __: ToolInvocationContext): Promise<ToolResult> =>
      Promise.resolve({ content: '', isError: false }),
  };
}

function gatheredToolNames(providers: readonly ToolProvider[]): string[] {
  const out: string[] = [];
  for (const p of providers) {
    const descs = p.describeTools() as readonly { name: string }[];
    for (const d of descs) out.push(d.name);
  }
  return out.sort();
}

describe('Substrate tool registration is cross-checked vs Agent.spec.tools', () => {
  /* ===================================================================
   * Test A — STRICT FAIL-FAST.
   *
   * Spec lists ['http_get'] only. The cluster opt-in `spawnTools`
   * provider is wired (env-flag fired in production). Spec did NOT list
   * `spawn_child_task` AND did not declare any spawn intent (empty
   * allowedChildAgents + allowedChildTemplates). Cross-check must fire
   * with a clear, operator-actionable error naming the offender + the
   * allowed list.
   * =================================================================== */
  it('throws fail-FAST when substrate provider exposes a tool the spec did not admit', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        // explicit empty intent — neither allowedChildAgents nor allowedChildTemplates
        allowedChildAgents: [],
        allowedChildTemplates: [],
      },
    };
    const spawnTools = fakeProvider('kagent-substrate', [
      'spawn_child_task',
      'wait_for_child_task',
      'wait_for_children_all',
      'get_my_context',
    ]);
    expect(() => resolveToolProviders(cfg, { spawnTools })).toThrow(/spawn_child_task/);
    expect(() => resolveToolProviders(cfg, { spawnTools })).toThrow(/Agent\.spec\.tools/);
  });

  /* ===================================================================
   * Test B — IMPLICIT ADMIT (spawn intent).
   *
   * Spec lists ['http_get']. allowedChildAgents=['summarizer'] declares
   * spawn intent at the schema level → spawn_child_task and the
   * wait_for_* tools are admitted implicitly.
   * =================================================================== */
  it('admits spawn_child_task + wait_* implicitly when allowedChildAgents is non-empty', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        allowedChildAgents: ['summarizer'],
      },
    };
    const spawnTools = fakeProvider('kagent-substrate', [
      'spawn_child_task',
      'wait_for_child_task',
      'wait_for_children_all',
      'ensure_agent_from_template',
      'get_my_context',
    ]);
    const providers = resolveToolProviders(cfg, { spawnTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('spawn_child_task');
    expect(names).toContain('wait_for_child_task');
    expect(names).toContain('wait_for_children_all');
    expect(names).toContain('ensure_agent_from_template');
    expect(names).toContain('get_my_context');
    expect(names).toContain('http_get');
  });

  it('admits spawn_child_task + wait_* implicitly when allowedChildTemplates is non-empty', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        allowedChildTemplates: ['research-template'],
      },
    };
    const spawnTools = fakeProvider('kagent-substrate', [
      'spawn_child_task',
      'wait_for_child_task',
      'wait_for_children_all',
      'ensure_agent_from_template',
    ]);
    const providers = resolveToolProviders(cfg, { spawnTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('spawn_child_task');
    expect(names).toContain('ensure_agent_from_template');
  });

  /* ===================================================================
   * Test C — IMPLICIT ADMIT (publish intent).
   *
   * Spec lists ['http_get'] with `publishes=[{topic:'rc.events'}]` AND
   * the events provider is wired. publish_event is admitted because the
   * Agent declared the topic.
   * =================================================================== */
  it('admits publish_event implicitly when publishes[] declares any topic', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        publishes: [{ topic: 'rc.events.researcher' }],
      },
    };
    const eventsTools = fakeProvider('kagent-events', ['publish_event']);
    const providers = resolveToolProviders(cfg, { eventsTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('publish_event');
  });

  it('admits publish_event implicitly when capabilityClaims.publish is non-empty', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        capabilityClaims: { publish: ['rc.events.researcher'] },
      },
    };
    const eventsTools = fakeProvider('kagent-events', ['publish_event']);
    const providers = resolveToolProviders(cfg, { eventsTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('publish_event');
  });

  it('rejects publish_event when neither publishes[] nor capabilityClaims.publish is set', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
      },
    };
    const eventsTools = fakeProvider('kagent-events', ['publish_event']);
    expect(() => resolveToolProviders(cfg, { eventsTools })).toThrow(/publish_event/);
  });

  /* ===================================================================
   * Test D — EXPLICIT ADMIT.
   *
   * Spec lists the substrate tool name explicitly. Cross-check passes
   * even when the implicit-when-X predicate would not fire. This is the
   * existing path; it must keep working.
   * =================================================================== */
  it('admits substrate tools when listed explicitly in Agent.spec.tools', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['spawn_child_task', 'wait_for_child_task', 'get_my_context', 'http_get'],
        allowedChildAgents: ['summarizer'], // required for spawn tool's own runtime guardrails
      },
    };
    const spawnTools = fakeProvider('kagent-substrate', [
      'spawn_child_task',
      'wait_for_child_task',
      'wait_for_children_all',
      'get_my_context',
    ]);
    const providers = resolveToolProviders(cfg, { spawnTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('spawn_child_task');
    expect(names).toContain('wait_for_child_task');
  });

  /* ===================================================================
   * Test E — get_my_context UNIVERSAL.
   *
   * Pure introspection — no authority widens via this tool. Admitted on
   * every Agent regardless of spec.tools / spawn intent / capability
   * claims. Matches the existing wiring in main.ts where get_my_context
   * is part of the kagent-substrate provider whenever spawn is enabled.
   * =================================================================== */
  it('admits get_my_context universally (introspection-only, no authority widens)', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        // NO spawn intent at all — the only thing the substrate provider
        // exposes that should be admitted is get_my_context.
      },
    };
    const ctxOnly = fakeProvider('kagent-substrate', ['get_my_context']);
    const providers = resolveToolProviders(cfg, { spawnTools: ctxOnly });
    const names = gatheredToolNames(providers);
    expect(names).toContain('get_my_context');
    expect(names).toContain('http_get');
  });

  /* ===================================================================
   * Test F — IMPLICIT ADMIT (artifact I/O).
   *
   * Spec declares an artifact input (or output) → read_artifact and
   * write_artifact are admitted implicitly. Mirrors the existing
   * `agentHasArtifactInputOrOutput` predicate in env.ts (which already
   * gates the underlying tool deps on the same condition).
   * =================================================================== */
  it('admits read_artifact + write_artifact implicitly when inputs[].kind=artifact', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        inputs: [{ name: 'doc', kind: 'artifact' }],
      },
    };
    // Pretend a future "artifact-tools" provider exposes these names —
    // structurally the same shape the substrate provider uses.
    const artifactTools = fakeProvider('kagent-artifacts', ['read_artifact', 'write_artifact']);
    const providers = resolveToolProviders(cfg, { spawnTools: artifactTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('read_artifact');
    expect(names).toContain('write_artifact');
  });

  it('admits read_artifact + write_artifact implicitly when outputs[].kind=artifact', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        outputs: [{ name: 'report', kind: 'artifact' }],
      },
    };
    const artifactTools = fakeProvider('kagent-artifacts', ['read_artifact', 'write_artifact']);
    const providers = resolveToolProviders(cfg, { spawnTools: artifactTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('read_artifact');
    expect(names).toContain('write_artifact');
  });

  /* ===================================================================
   * Test G — IMPLICIT ADMIT (blackboard).
   *
   * Blackboard tools are admitted implicitly when the env-flag fired
   * (provider was wired) AND the Agent declared either spawn intent or
   * pub/sub intent. Per the audit: "or just admit when the env-flag
   * fires and the cap supports it — pick the simpler shape." We pick
   * the simpler shape: presence of the wired blackboard provider AND
   * any task-graph intent (spawn or publishes) admits the blackboard
   * tools.
   *
   * A pure single-agent chat-only Agent that did NOT list
   * read_blackboard explicitly and has no graph intent → still rejected
   * per the strict default.
   * =================================================================== */
  it('admits read/write_blackboard implicitly when Agent has spawn intent', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
        allowedChildAgents: ['summarizer'],
      },
    };
    const blackboardTools = fakeProvider('kagent-blackboard', [
      'read_blackboard',
      'write_blackboard',
      'list_blackboard',
      'append_blackboard',
    ]);
    const providers = resolveToolProviders(cfg, { blackboardTools });
    const names = gatheredToolNames(providers);
    expect(names).toContain('read_blackboard');
    expect(names).toContain('write_blackboard');
  });

  it('rejects blackboard tools when Agent has no graph intent and tools not listed', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
      },
    };
    const blackboardTools = fakeProvider('kagent-blackboard', ['read_blackboard']);
    expect(() => resolveToolProviders(cfg, { blackboardTools })).toThrow(/read_blackboard/);
  });

  /* ===================================================================
   * Test H — error message names ALL offenders, not just the first.
   *
   * Operator-actionable: when several tools fail the gate, the message
   * should list them all so the operator fixes the manifest in one
   * pass. (This mirrors the spirit of `resolveBuiltinTools`'s "known
   * built-ins: ..." trailer.)
   * =================================================================== */
  it('error message lists all rejected substrate tools, not just the first', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['http_get'],
      },
    };
    const provider = fakeProvider('kagent-substrate', [
      'spawn_child_task',
      'publish_event',
      'read_blackboard',
    ]);
    expect(() => resolveToolProviders(cfg, { spawnTools: provider })).toThrow(/spawn_child_task/);
    expect(() => resolveToolProviders(cfg, { spawnTools: provider })).toThrow(/publish_event/);
    expect(() => resolveToolProviders(cfg, { spawnTools: provider })).toThrow(/read_blackboard/);
  });
});
