/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpToolProvider, _classifyMcpErrorForTests } from './provider.js';
import {
  InvalidConfigError,
  McpToolProviderAbortError,
  McpToolProviderProtocolError,
  McpToolProviderSubprocessError,
} from '@kagent/agent-loop';
import type { ToolCall, ToolInvocationContext } from '@kagent/agent-loop';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/test-mcp-server.ts', import.meta.url));

const ctx = (signal?: AbortSignal): ToolInvocationContext => ({
  runId: 'test-run',
  abortSignal: signal ?? new AbortController().signal,
});

const call = (name: string, args?: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name,
  args: args ?? {},
});

let providers: McpToolProvider[] = [];

afterEach(async () => {
  for (const p of providers) {
    try {
      await p.close();
    } catch {
      /* swallow — subprocess cleanup is best-effort */
    }
  }
  providers = [];
});

function spawnFixtureProvider(
  envOverride?: Record<string, string>,
  envAllowlist?: readonly string[],
): McpToolProvider {
  const opts: ConstructorParameters<typeof McpToolProvider>[0] = {
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE_PATH],
  };
  if (envOverride !== undefined) opts.env = envOverride;
  if (envAllowlist !== undefined) opts.envAllowlist = envAllowlist;
  const p = new McpToolProvider(opts);
  providers.push(p);
  return p;
}

describe('McpToolProvider — constructor + lifecycle (D-12, D-13)', () => {
  it('Test 9 — missing command throws InvalidConfigError', () => {
    expect(() => new McpToolProvider({ command: '' })).toThrow(InvalidConfigError);
  });

  it("Test 10 — id defaults to 'mcp-stdio'; override works", () => {
    const p = new McpToolProvider({ command: 'true' });
    expect(p.id).toBe('mcp-stdio');
    const p2 = new McpToolProvider({ id: 'custom', command: 'true' });
    expect(p2.id).toBe('custom');
  });

  it('Test 7 — close() is idempotent (double-close no-op)', async () => {
    const p = spawnFixtureProvider();
    await p.describeTools(); // force lazy-spawn
    await p.close();
    await expect(p.close()).resolves.toBeUndefined();
  });

  it('Test 11 — ENOENT spawn failure → McpToolProviderSubprocessError', async () => {
    const p = new McpToolProvider({ command: 'nonexistent-binary-xyz123' });
    providers.push(p);
    await expect(p.describeTools()).rejects.toBeInstanceOf(McpToolProviderSubprocessError);
  });

  it('Test 12 — using provider after close() throws McpToolProviderSubprocessError', async () => {
    const p = spawnFixtureProvider();
    await p.describeTools();
    await p.close();
    await expect(p.executeTool(call('mcp_echo', { text: 'x' }), ctx())).rejects.toBeInstanceOf(
      McpToolProviderSubprocessError,
    );
  });
});

describe('McpToolProvider — describeTools + cache (D-15, D-18)', () => {
  it('Test 1 — lazy-spawn: constructor does NOT spawn; first describeTools() does', async () => {
    const p = spawnFixtureProvider();
    // Constructor returned; no async work yet — spawn happens on first call.
    const desc = await p.describeTools();
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.some((d) => d.name === 'mcp_echo')).toBe(true);
  });

  it('Test 2 — cache reuse: second describeTools() returns same descriptors', async () => {
    const p = spawnFixtureProvider();
    const first = await p.describeTools();
    const second = await p.describeTools();
    // Same array reference (cache hit returns the cached array)
    expect(second).toBe(first);
  });
});

describe('McpToolProvider — describeTools cancellation (WS-G)', () => {
  it('pre-aborted signal short-circuits before spawning the subprocess', async () => {
    const p = spawnFixtureProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(p.describeTools(ctx(controller.signal))).rejects.toBeInstanceOf(
      McpToolProviderAbortError,
    );
  });

  it('passing a non-aborted ctx still resolves to the tool list', async () => {
    const p = spawnFixtureProvider();
    const desc = await p.describeTools(ctx());
    expect(desc.some((d) => d.name === 'mcp_echo')).toBe(true);
  });

  it('omitting ctx preserves the legacy signature behavior', async () => {
    // Existing callers that called describeTools() with no args must
    // still work — the parameter is optional.
    const p = spawnFixtureProvider();
    const desc = await p.describeTools();
    expect(desc.length).toBeGreaterThan(0);
  });
});

describe('McpToolProvider — executeTool happy path (D-16)', () => {
  it('Test 4 — tools/call mcp_echo returns flat-string content', async () => {
    const p = spawnFixtureProvider();
    const result = await p.executeTool(call('mcp_echo', { text: 'hello' }), ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello');
  });
});

describe('McpToolProvider — executeTool error paths (D-16, D-17, D-23)', () => {
  it('Test 6 — pre-aborted signal throws McpToolProviderAbortError', async () => {
    const p = spawnFixtureProvider();
    await p.describeTools(); // ensure connected
    const controller = new AbortController();
    controller.abort();
    await expect(
      p.executeTool(call('mcp_echo', { text: 'x' }), ctx(controller.signal)),
    ).rejects.toBeInstanceOf(McpToolProviderAbortError);
  });
});

describe('McpToolProvider — env merge (D-14, RESEARCH §Pitfall 3, WS-A)', () => {
  it("Test 8 — envAllowlist:['*'] forwards everything; child sees MY_VAR + inherited PATH", async () => {
    const p = spawnFixtureProvider({ MY_VAR: 'phase-5-test' }, ['*']);
    const result = await p.executeTool(call('env_dump'), ctx());
    const envJson = result.content as string;
    const env: Record<string, string> = JSON.parse(envJson) as Record<string, string>;
    expect(env['MY_VAR']).toBe('phase-5-test');
    // Inherited from process.env (PATH always set on POSIX; on Windows use Path)
    expect(env['PATH'] !== undefined || env['Path'] !== undefined).toBe(true);
  });

  it("WS-A default — empty allowlist masks process.env (HOME / PATH absent or '')", async () => {
    // Sanity: parent has HOME (POSIX) or USERPROFILE (Windows) set —
    // we want to prove they don't propagate.
    expect(process.env.HOME !== undefined || process.env.USERPROFILE !== undefined).toBe(true);

    const p = spawnFixtureProvider({ MY_VAR: 'kept' });
    const result = await p.executeTool(call('env_dump'), ctx());
    const env: Record<string, string> = JSON.parse(result.content as string) as Record<
      string,
      string
    >;
    expect(env['MY_VAR']).toBe('kept');
    // The SDK's StdioClientTransport always merges its
    // getDefaultEnvironment() set (HOME, PATH, USER, ...) when an
    // `env` map is passed. We mask those keys to '' so the child
    // sees an empty value instead of the parent's (e.g. a leaked
    // home directory path).
    expect(env['HOME'] ?? '').toBe('');
    expect(env['PATH'] ?? '').toBe('');
    expect(env['USERPROFILE'] ?? '').toBe('');
    // None of these should equal the parent's value.
    if (process.env.HOME !== undefined) expect(env['HOME']).not.toBe(process.env.HOME);
    if (process.env.PATH !== undefined) expect(env['PATH']).not.toBe(process.env.PATH);
  });

  it('explicit allowlist forwards only listed keys', async () => {
    process.env.MCP_TEST_ALLOWED = 'yes';
    process.env.MCP_TEST_BLOCKED = 'no';
    try {
      const p = spawnFixtureProvider(undefined, ['MCP_TEST_ALLOWED']);
      const result = await p.executeTool(call('env_dump'), ctx());
      const env: Record<string, string> = JSON.parse(result.content as string) as Record<
        string,
        string
      >;
      expect(env['MCP_TEST_ALLOWED']).toBe('yes');
      expect(env['MCP_TEST_BLOCKED']).toBeUndefined();
    } finally {
      delete process.env.MCP_TEST_ALLOWED;
      delete process.env.MCP_TEST_BLOCKED;
    }
  });

  it("envAllowlist:['*'] logs a deprecation warning at construction", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = new McpToolProvider({
        command: 'true',
        envAllowlist: ['*'],
      });
      providers.push(p);
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toMatch(/envAllowlist:\['\*'\]/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('McpToolProvider — isError preservation (D-16)', () => {
  it('Test 5 — tools/call with isError true returned as ToolResult{isError:true} (NOT thrown)', async () => {
    const p = spawnFixtureProvider();
    const result = await p.executeTool(call('force_error'), ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('forced error');
  });
});

describe('McpToolProvider — cache invalidation on notifications/tools/list_changed (D-15, D-18)', () => {
  it('Test 3 — describeTools() re-fetches after server-pushed list_changed notification', async () => {
    const p = spawnFixtureProvider();
    const first = await p.describeTools();
    expect(first.some((t) => t.name === 'mutated_tool')).toBe(false);

    // Trigger the fixture to push notifications/tools/list_changed
    await p.executeTool(call('mutate_tools'), ctx());

    // Allow notification round-trip to settle (small await; no fixed sleep).
    // The SDK delivers notifications on the same stdio transport — by the time
    // the next describeTools() makes its tools/list request, the notification
    // handler has already invalidated the cache.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await p.describeTools();
    // Different array reference (cache miss → re-fetch produced a new array)
    expect(second).not.toBe(first);
    // New tool list reflects the mutated state
    expect(second.some((t) => t.name === 'mutated_tool')).toBe(true);
  });
});

describe('classifyMcpError — direct unit tests on RESEARCH §Mapping table (D-16)', () => {
  it('Test C1 — McpError(ConnectionClosed) → McpToolProviderSubprocessError', () => {
    const sdkErr = new McpError(ErrorCode.ConnectionClosed, 'connection closed mid-call');
    const out = _classifyMcpErrorForTests(sdkErr, false);
    expect(out).toBeInstanceOf(McpToolProviderSubprocessError);
  });

  it('Test C2 — McpError(RequestTimeout) + signalAborted=true → McpToolProviderAbortError', () => {
    const sdkErr = new McpError(ErrorCode.RequestTimeout, 'request timed out');
    const out = _classifyMcpErrorForTests(sdkErr, true);
    expect(out).toBeInstanceOf(McpToolProviderAbortError);
  });

  it('Test C3 — McpError(RequestTimeout) + signalAborted=false → McpToolProviderProtocolError', () => {
    const sdkErr = new McpError(ErrorCode.RequestTimeout, 'request timed out (server hang)');
    const out = _classifyMcpErrorForTests(sdkErr, false);
    expect(out).toBeInstanceOf(McpToolProviderProtocolError);
  });

  it('Test C4 — McpError(InvalidRequest) → McpToolProviderProtocolError', () => {
    const sdkErr = new McpError(ErrorCode.InvalidRequest, 'invalid request');
    const out = _classifyMcpErrorForTests(sdkErr, false);
    expect(out).toBeInstanceOf(McpToolProviderProtocolError);
  });

  it('Test C5 — McpError(MethodNotFound) → McpToolProviderProtocolError', () => {
    const sdkErr = new McpError(ErrorCode.MethodNotFound, 'tools/call not found');
    const out = _classifyMcpErrorForTests(sdkErr, false);
    expect(out).toBeInstanceOf(McpToolProviderProtocolError);
  });

  it('Test C6 — generic Error (non-McpError) → McpToolProviderSubprocessError', () => {
    const out = _classifyMcpErrorForTests(new Error('spawn ENOENT'), false);
    expect(out).toBeInstanceOf(McpToolProviderSubprocessError);
    expect(out.message).toBe('spawn ENOENT');
  });

  it('Test C7 — non-Error throw (string) → McpToolProviderSubprocessError with stringified message', () => {
    const out = _classifyMcpErrorForTests('weird transport error', false);
    expect(out).toBeInstanceOf(McpToolProviderSubprocessError);
    expect(out.message).toBe('weird transport error');
  });
});
