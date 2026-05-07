/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 2 — `buildSubstrateTools`.
 *
 * R3 §4.1 requires: `spawn_child_task` re-emit calls underlying impl;
 * capability JWT verified before execute.
 */

import { describe, expect, it, vi } from 'vitest';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';
import type { CapabilityBundle } from '@kagent/capability-types';

import { buildSubstrateTools } from './substrate-tools-adapter.js';

function makeBundle(claims: CapabilityBundle['claims']): CapabilityBundle {
  return {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task:test',
    aud: ['kagent.substrate.v1'],
    exp: 9_999_999_999,
    jti: 'cap-test',
    claims,
  };
}

function makeStubDef(
  name: string,
  handler: InProcessToolDefinition['handler'],
): InProcessToolDefinition {
  return {
    name,
    description: `stub: ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    handler,
  };
}

type Runner = (i: unknown, o: { abortSignal?: AbortSignal }) => Promise<unknown>;

describe('buildSubstrateTools', () => {
  it('emits Vercel AI SDK tool shapes that delegate to the kagent handler', async () => {
    const handler = vi.fn(() => Promise.resolve('spawned: child-x'));
    const def = makeStubDef('spawn_child_task', handler);
    const { tools, toolNames } = buildSubstrateTools({
      definitions: [def],
      runId: 'run-1',
    });
    expect(toolNames).toEqual(['spawn_child_task']);
    expect(tools.spawn_child_task).toBeDefined();
    const runner = tools.spawn_child_task!.execute as Runner;
    const result = await runner({ agentName: 'child-x', originalUserMessage: 'go' }, {});
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      { agentName: 'child-x', originalUserMessage: 'go' },
      expect.objectContaining({ runId: 'run-1' }),
    );
    expect(result).toBe('spawned: child-x');
  });

  it('honors admittedToolNames whitelist', () => {
    const a = makeStubDef('a', () => 'a');
    const b = makeStubDef('b', () => 'b');
    const { toolNames } = buildSubstrateTools({
      definitions: [a, b],
      admittedToolNames: ['b'],
      runId: 'run-1',
    });
    expect(toolNames).toEqual(['b']);
  });

  it('wraps tools with capability check when a binding is provided', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'));
    const def = makeStubDef('spawn_child_task', handler);
    const bundle = makeBundle({ spawn: ['summarizer-*'], tenant: 't' });
    const { tools } = buildSubstrateTools({
      definitions: [def],
      capabilityBindings: {
        spawn_child_task: {
          category: 'spawn',
          target: (input) => (input as { agentName?: string }).agentName,
        },
      },
      capabilityBundle: bundle,
      runId: 'run-1',
    });
    const runner = tools.spawn_child_task!.execute as Runner;
    // Outside cap — refuses BEFORE the underlying handler fires.
    await expect(runner({ agentName: 'researcher' }, {})).rejects.toThrow(
      /policy_denied:capability_violation/,
    );
    expect(handler).not.toHaveBeenCalled();
    // Inside cap — proceeds.
    await runner({ agentName: 'summarizer-7' }, {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it('coerces stringified JSON args to the underlying handler', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'));
    const def = makeStubDef('foo', handler);
    const { tools } = buildSubstrateTools({
      definitions: [def],
      runId: 'run-1',
    });
    const runner = tools.foo!.execute as Runner;
    await runner(JSON.stringify({ x: 1 }), {});
    expect(handler).toHaveBeenCalledWith({ x: 1 }, expect.anything());
  });

  it('forwards abortSignal from ToolExecutionOptions into the kagent ctx', async () => {
    const handler = vi.fn((_args, ctx: { abortSignal?: AbortSignal }) => {
      return ctx.abortSignal?.aborted ? 'aborted' : 'live';
    });
    const def = makeStubDef('foo', handler);
    const { tools } = buildSubstrateTools({
      definitions: [def],
      runId: 'run-1',
    });
    const ac = new AbortController();
    ac.abort();
    const runner = tools.foo!.execute as Runner;
    const result = await runner({}, { abortSignal: ac.signal });
    expect(result).toBe('aborted');
  });

  it('passes through ContentBlock[] handler returns as structured arrays', async () => {
    const def = makeStubDef('multi', () => [
      { type: 'text' as const, text: 'hello' },
      { type: 'text' as const, text: 'world' },
    ]);
    const { tools } = buildSubstrateTools({
      definitions: [def],
      runId: 'run-1',
    });
    const runner = tools.multi!.execute as Runner;
    const result = await runner({}, {});
    expect(Array.isArray(result)).toBe(true);
    expect((result as { type: string }[])[0]?.type).toBe('text');
  });

  it('marks ToolResult.isError handler returns with isError flag for the model', async () => {
    const def = makeStubDef('failing', () => ({
      content: 'something went wrong',
      isError: true,
    }));
    const { tools } = buildSubstrateTools({
      definitions: [def],
      runId: 'run-1',
    });
    const runner = tools.failing!.execute as Runner;
    const result = (await runner({}, {})) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
