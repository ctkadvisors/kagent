/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Behavioral tests for InProcessToolProvider — D-19/20/22/23 + ROADMAP SC3.
 */

import { describe, it, expect } from 'vitest';
import { InProcessToolProvider } from './provider.js';
import { InvalidConfigError } from '@kagent/agent-loop';
import type { ToolCall, ToolInvocationContext } from '@kagent/agent-loop';

const ctx = (signal?: AbortSignal): ToolInvocationContext => ({
  runId: 'test-run',
  abortSignal: signal ?? new AbortController().signal,
});

const call = (name: string, args?: unknown): ToolCall => ({
  id: 'c1',
  name,
  args: args ?? {},
});

describe('InProcessToolProvider — handler dispatch (D-19, ROADMAP SC3)', () => {
  it('Test 1 — sync handler returning string is wrapped to { content, isError: false }', async () => {
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'echo',
          description: '',
          inputSchema: {},
          handler: () => 'hello',
        },
      ],
    });
    const result = await provider.executeTool(call('echo'), ctx());
    expect(result).toEqual({ content: 'hello', isError: false });
  });

  it('Test 2 — async handler returning Promise<string> is wrapped identically', async () => {
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'echo',
          description: '',
          inputSchema: {},
          handler: () => Promise.resolve('world'),
        },
      ],
    });
    const result = await provider.executeTool(call('echo'), ctx());
    expect(result).toEqual({ content: 'world', isError: false });
  });

  it('Test 3 — handler returning ContentBlock[] is wrapped (Array.isArray branch)', async () => {
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'multi',
          description: '',
          inputSchema: {},
          handler: () => [{ type: 'text' as const, text: 'multi' }],
        },
      ],
    });
    const result = await provider.executeTool(call('multi'), ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'multi' }]);
  });

  it('Test 4 — handler returning full ToolResult is returned verbatim (escape hatch)', async () => {
    const tr = { content: 'custom', isError: true, metadata: { x: 1 } };
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'pass',
          description: '',
          inputSchema: {},
          handler: () => tr,
        },
      ],
    });
    const result = await provider.executeTool(call('pass'), ctx());
    expect(result).toEqual(tr);
  });
});

describe('InProcessToolProvider — thrown-error mapping (D-20)', () => {
  it('Test 5 — handler throws Error → ToolResult{isError:true} with message + truncated stack', async () => {
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'fail',
          description: '',
          inputSchema: {},
          handler: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const result = await provider.executeTool(call('fail'), ctx());
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe('string');
    expect(result.content as string).toContain('boom');
    expect(result.metadata?.['errorName']).toBe('Error');
    // Verify stack is truncated: count newlines in content; should be ≤6 (message + up to 5 frames).
    const lineCount = (result.content as string).split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(6);
  });

  it('Test 6 — handler throws non-Error (string) → ToolResult with errorName "string"', async () => {
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'fail2',
          description: '',
          inputSchema: {},
          handler: () => {
            // Intentionally throw a non-Error to exercise the non-Error
            // branch of the catch handler (D-20). ESLint's `only-throw-error`
            // is correct in production code but is the test's purpose here.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'string-throw';
          },
        },
      ],
    });
    const result = await provider.executeTool(call('fail2'), ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('string-throw');
    expect(result.metadata?.['errorName']).toBe('string');
  });

  it('Test 5b — handler throws Error WITHOUT a stack → message-only content (no stack branch)', async () => {
    // Construct an Error and forcibly clear its stack to exercise the
    // `stack ? ... : undefined` branch (else-arm) of the mapping.
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'fail3',
          description: '',
          inputSchema: {},
          handler: () => {
            const err = new Error('stackless');
            // Clear the stack to drive the no-stack branch in the catch handler.
            (err as { stack?: string }).stack = undefined;
            throw err;
          },
        },
      ],
    });
    const result = await provider.executeTool(call('fail3'), ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('stackless');
    expect(result.metadata?.['errorName']).toBe('Error');
  });
});

describe('InProcessToolProvider — id + constructor validation', () => {
  it("Test 7 — id defaults to 'in-process'", () => {
    const provider = new InProcessToolProvider({ tools: [] });
    expect(provider.id).toBe('in-process');
  });

  it('Test 8 — id is overridable', () => {
    const provider = new InProcessToolProvider({ id: 'math', tools: [] });
    expect(provider.id).toBe('math');
  });

  it('Test 9 — executeTool with unknown tool name throws InvalidConfigError', async () => {
    const provider = new InProcessToolProvider({ tools: [] });
    await expect(provider.executeTool(call('nonexistent'), ctx())).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
  });

  it('Test 10 — missing tools array throws InvalidConfigError(field=tools)', () => {
    expect(() => new InProcessToolProvider({ tools: undefined as never })).toThrow(
      InvalidConfigError,
    );
    try {
      new InProcessToolProvider({ tools: undefined as never });
      expect.fail('expected InvalidConfigError to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidConfigError);
      expect((err as InvalidConfigError).field).toBe('tools');
    }
  });

  it('Test 10b — non-array tools (object) throws InvalidConfigError(field=tools)', () => {
    expect(
      () => new InProcessToolProvider({ tools: { not: 'array' } as unknown as never }),
    ).toThrow(InvalidConfigError);
  });
});

describe('InProcessToolProvider — abort plumbing (D-23)', () => {
  it('Test 11 — handler receives ctx with abortSignal; reads .aborted', async () => {
    const controller = new AbortController();
    let observedAborted: boolean | undefined;
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'spy',
          description: '',
          inputSchema: {},
          handler: (_args, c) => {
            observedAborted = c.abortSignal.aborted;
            return 'observed';
          },
        },
      ],
    });
    controller.abort();
    await provider.executeTool(call('spy'), ctx(controller.signal));
    expect(observedAborted).toBe(true);
  });
});

describe('InProcessToolProvider — describeTools', () => {
  it('Test 13 — describeTools returns descriptors without handler property', () => {
    const provider = new InProcessToolProvider({
      tools: [
        { name: 't1', description: 'd1', inputSchema: { x: 1 }, handler: () => 'a' },
        { name: 't2', description: 'd2', inputSchema: { y: 2 }, handler: () => 'b', tags: ['t'] },
      ],
    });
    const desc = provider.describeTools();
    expect(desc).toHaveLength(2);
    expect(desc[0]).toEqual({ name: 't1', description: 'd1', inputSchema: { x: 1 } });
    expect(desc[1]).toEqual({ name: 't2', description: 'd2', inputSchema: { y: 2 }, tags: ['t'] });
    // descriptor MUST NOT include 'handler'.
    expect('handler' in (desc[0] as object)).toBe(false);
    expect('handler' in (desc[1] as object)).toBe(false);
  });

  it('Test 13b — call.args undefined defaults to {} (default-args branch)', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const provider = new InProcessToolProvider({
      tools: [
        {
          name: 'capture',
          description: '',
          inputSchema: {},
          handler: (args) => {
            receivedArgs = args;
            return 'ok';
          },
        },
      ],
    });
    // ToolCall.args is typed as `unknown` per Phase 3 D-08; provider must
    // tolerate undefined by defaulting to {}.
    await provider.executeTool({ id: 'c', name: 'capture', args: undefined }, ctx());
    expect(receivedArgs).toEqual({});
  });
});
