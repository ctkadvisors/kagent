/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `ToolProvider` interface + `ToolProviderRegistry` tests.
 */

import { describe, it, expect } from 'vitest';
import type {
  ToolProvider,
  ToolDescriptor,
  ToolResult,
  ToolInvocationContext,
} from './tool-provider.js';
import { ToolProviderRegistry } from './tool-provider.js';
import { DuplicateToolNameError } from './errors.js';
import { makeStubToolProvider } from './__fixtures__/stub-tool-provider.js';

describe('ToolProvider — interface shape', () => {
  it('SC2.1: ToolProvider shape compiles; id is string; describeTools() returns sync or async', () => {
    const sync: ToolProvider = {
      id: 'sync-prov',
      describeTools: (): ToolDescriptor[] => [],
      executeTool: (): Promise<ToolResult> => Promise.resolve({ content: 'ok', isError: false }),
    };
    const async_: ToolProvider = {
      id: 'async-prov',
      describeTools: (): Promise<ToolDescriptor[]> => Promise.resolve([]),
      executeTool: (): Promise<ToolResult> => Promise.resolve({ content: 'ok', isError: false }),
    };
    expect(sync.id).toBe('sync-prov');
    expect(async_.id).toBe('async-prov');
    expect(typeof sync.describeTools).toBe('function');
  });

  it('resolveName: a namespace or leaf that denotes one registered tool resolves to it; ambiguity does not', () => {
    const reg = new ToolProviderRegistry();
    reg.register(
      makeStubToolProvider({
        id: 'gw',
        tools: [
          'code_interpreter.execute_code',
          'browser.goto',
          'mcp.cf.search',
          'http.search',
        ].map((name) => ({
          name,
          description: '',
          inputSchema: {},
        })),
      }),
    );
    expect(reg.resolveName('code_interpreter.execute_code')).toBe('code_interpreter.execute_code');
    expect(reg.resolveName('code_interpreter')).toBe('code_interpreter.execute_code');
    expect(reg.resolveName('execute_code')).toBe('code_interpreter.execute_code');
    expect(reg.resolveName('search')).toBeUndefined(); // mcp.cf.search and http.search
    expect(reg.candidatesFor('search').sort()).toEqual(['http.search', 'mcp.cf.search']);
    expect(reg.resolveName('nothing')).toBeUndefined();
    expect(reg.candidatesFor('nothing')).toEqual([]);
  });

  it('SC2.2: ToolProviderRegistry registers two providers; providerFor(name) resolves correctly', () => {
    const reg = new ToolProviderRegistry();
    reg.register(
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
      }),
    );
    reg.register(
      makeStubToolProvider({
        id: 'p2',
        tools: [{ name: 'shout', description: '', inputSchema: {} }],
      }),
    );
    expect(reg.providerFor('echo')?.id).toBe('p1');
    expect(reg.providerFor('shout')?.id).toBe('p2');
    expect(reg.providerFor('missing')).toBeUndefined();
    expect(reg.getAll()).toHaveLength(2);
  });

  it('SC2.3: Conflict — two providers claim the same tool name; registry throws DuplicateToolNameError', () => {
    const reg = new ToolProviderRegistry();
    reg.register(
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
      }),
    );
    expect(() =>
      reg.register(
        makeStubToolProvider({
          id: 'p2',
          tools: [{ name: 'echo', description: '', inputSchema: {} }],
        }),
      ),
    ).toThrow(DuplicateToolNameError);
  });

  it('SC2.4: describeAll() federates and concatenates all providers tool descriptors', async () => {
    const reg = new ToolProviderRegistry();
    reg.register(
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
      }),
    );
    reg.register(
      makeStubToolProvider({
        id: 'p2',
        tools: [
          { name: 'shout', description: '', inputSchema: {} },
          { name: 'noop', description: '', inputSchema: {} },
        ],
      }),
    );
    const all = await reg.describeAll();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.name).sort()).toEqual(['echo', 'noop', 'shout']);
  });

  it('SC2.5: executeTool() receives ToolInvocationContext with runId, abortSignal, parentRunId undefined', async () => {
    let receivedCtx: ToolInvocationContext | null = null;
    const provider = makeStubToolProvider({
      id: 'p1',
      tools: [{ name: 'echo', description: '', inputSchema: {} }],
      onCall: (_call, ctx) => {
        receivedCtx = ctx;
        return { content: 'ok', isError: false };
      },
    });
    const ctx: ToolInvocationContext = {
      runId: 'run-x',
      abortSignal: new AbortController().signal,
    };
    await provider.executeTool({ id: 'c1', name: 'echo', args: {} }, ctx);
    expect(receivedCtx).not.toBeNull();
    expect(receivedCtx!.runId).toBe('run-x');
    expect(receivedCtx!.abortSignal).toBeDefined();
    expect(receivedCtx!.parentRunId).toBeUndefined();
  });

  it('SC2.7: ToolDescriptor.inputSchema is JSON-Schema-compatible (Record<string, unknown>)', () => {
    const desc: ToolDescriptor = {
      name: 'echo',
      description: 'echoes input',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
    };
    expect(typeof desc.inputSchema).toBe('object');
    expect((desc.inputSchema as { type: string }).type).toBe('object');
  });

  it('SC2.8: NO MCP SDK package import in tool-provider.ts (grep gate)', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'tool-provider.ts'), 'utf8');
    expect(src.match(/@modelcontextprotocol\/sdk/)).toBeNull();
  });

  it('SC2.8b: describeAll() awaits async describeTools() before populating toolToProvider (D-13)', async () => {
    const registry = new ToolProviderRegistry();
    const asyncProvider: ToolProvider = {
      id: 'async-test',
      async describeTools(): Promise<ToolDescriptor[]> {
        // Simulate a real async-provider delay (e.g., MCP stdio handshake).
        await new Promise((r) => setTimeout(r, 5));
        return [{ name: 'async_tool', description: 'd', inputSchema: {} }];
      },
      executeTool(): Promise<ToolResult> {
        return Promise.resolve({ content: 'ok', isError: false });
      },
    };
    registry.register(asyncProvider);

    // register() is sync; providerFor() is undefined IMMEDIATELY after
    // because the async describeTools() Promise has not yet resolved.
    expect(registry.providerFor('async_tool')).toBeUndefined();

    // After describeAll() resolves, toolToProvider is fully populated
    // because describeAll() awaits ready() FIRST per the D-13 fix.
    const all = await registry.describeAll();
    expect(all.find((d) => d.name === 'async_tool')).toBeDefined();
    expect(registry.providerFor('async_tool')).toBe(asyncProvider);
  });

  it('SC2.9b: ready() resolves immediately for sync-only registrations (D-13)', async () => {
    const registry = new ToolProviderRegistry();
    const syncProvider: ToolProvider = {
      id: 'sync-test',
      describeTools(): ToolDescriptor[] {
        return [{ name: 'sync_tool', description: 'd', inputSchema: {} }];
      },
      executeTool(): Promise<ToolResult> {
        return Promise.resolve({ content: 'ok', isError: false });
      },
    };
    registry.register(syncProvider);
    await registry.ready();
    expect(registry.providerFor('sync_tool')).toBe(syncProvider);
  });

  it('a provider unreachable at register time is retried, not cached as a permanent failure', async () => {
    const registry = new ToolProviderRegistry();
    let reachable = false;
    const flaky: ToolProvider = {
      id: 'flaky',
      describeTools(): Promise<ToolDescriptor[]> {
        if (!reachable) return Promise.reject(new Error('fetch failed'));
        return Promise.resolve([{ name: 'flaky_tool', description: 'd', inputSchema: {} }]);
      },
      executeTool(): Promise<ToolResult> {
        return Promise.resolve({ content: 'ok', isError: false });
      },
    };
    registry.register(flaky);

    // Still down: the error reaches the awaiter.
    await expect(registry.describeAll()).rejects.toThrow('fetch failed');

    // Back up: the next call heals without re-registering or restarting.
    reachable = true;
    const all = await registry.describeAll();
    expect(all.map((d) => d.name)).toEqual(['flaky_tool']);
    expect(registry.providerFor('flaky_tool')).toBe(flaky);
  });

  it('concurrent ready() calls share one retry; none reports ready while it is still pending', async () => {
    const registry = new ToolProviderRegistry();
    let calls = 0;
    let release: (tools: ToolDescriptor[]) => void = () => undefined;
    const slow: ToolProvider = {
      id: 'slow',
      describeTools(): Promise<ToolDescriptor[]> {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('fetch failed'));
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      executeTool(): Promise<ToolResult> {
        return Promise.resolve({ content: 'ok', isError: false });
      },
    };
    registry.register(slow);

    let settled = 0;
    const both = Promise.all([
      registry.ready().then(() => (settled += 1)),
      registry.ready().then(() => (settled += 1)),
    ]);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(0); // the retry is in flight; nobody is ready yet
    expect(calls).toBe(2); // one failed claim + one shared retry

    release([{ name: 'slow_tool', description: 'd', inputSchema: {} }]);
    await both;
    expect(registry.providerFor('slow_tool')).toBe(slow);
  });
});
