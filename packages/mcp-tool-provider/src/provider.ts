/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `McpToolProvider` — `ToolProvider` impl wrapping the official
 * `@modelcontextprotocol/sdk` to spawn MCP servers as subprocesses
 * (stdio transport). Discovers tools via `tools/list` and invokes
 * via `tools/call`.
 *
 * Lifecycle (D-13):
 *   - Lazy-spawn: child process spawned on first describeTools() / executeTool()
 *   - Connection reuse on subsequent calls
 *   - Explicit `close()` is idempotent; sends EOF + waits for child exit
 *   - AgentExecutor does NOT call close() — consumer-owned (D-13)
 *
 * Env merge (D-14 / RESEARCH §Pitfall 3):
 *   - SDK does NOT merge user env with process.env (uses verbatim map)
 *   - We merge: `env: { ...process.env, ...userEnv }` BEFORE passing to transport
 *
 * tools/list caching (D-15 / D-18):
 *   - First call: spawn + initialize + tools/list + cache
 *   - Subsequent calls: return cached descriptors
 *   - notifications/tools/list_changed: invalidate cache (Pattern A — no proactive re-fetch)
 *
 * Error mapping (D-16 / RESEARCH §Mapping table):
 *   - SDK McpError code -32000 (ConnectionClosed)         → McpToolProviderSubprocessError
 *   - SDK McpError code -32001 + signal.aborted           → McpToolProviderAbortError
 *   - SDK McpError code -32001 + !signal.aborted          → McpToolProviderProtocolError
 *   - SDK McpError JSON-RPC codes                         → McpToolProviderProtocolError
 *   - Spawn failure (ENOENT etc.)                         → McpToolProviderSubprocessError
 *   - result.isError === true (NOT thrown)                → ToolResult{isError:true}
 *
 * AbortSignal: passed to SDK as `{ signal: ctx.abortSignal, timeout: 0 }` —
 * `timeout: 0` disables the SDK's default 60s timeout (RESEARCH §Pitfall 2);
 * cancellation is exclusively via AbortSignal.
 */

import type {
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import {
  InvalidConfigError,
  McpToolProviderAbortError,
  McpToolProviderProtocolError,
  McpToolProviderSubprocessError,
} from '@kagent/agent-loop';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { mapMcpResultToToolResult } from './content-mapper.js';

interface SpawnOptionsLite {
  windowsHide?: boolean;
  // Add other passthrough fields as needed; intentionally narrow.
}

export interface McpToolProviderOptions {
  /** Stable provider id; defaults to 'mcp-stdio'. Override for multi-MCP scenarios. */
  id?: string;
  /** REQUIRED — the executable to spawn (e.g., 'npx', '/usr/local/bin/mcp-server'). */
  command: string;
  /** Arguments to pass to the executable. */
  args?: string[];
  /**
   * Environment variables — explicit overrides handed verbatim to the
   * child process. Combined with `envAllowlist` below: the final env
   * map is `{ ...filteredProcessEnv, ...env }`.
   */
  env?: Record<string, string>;
  /**
   * WS-A baseline: instead of inheriting all of `process.env`, the
   * caller declares which keys to forward. Default (omitted / empty
   * array) forwards NOTHING — only `env` overrides reach the child.
   * Pass an explicit list (e.g. `['PATH', 'HOME', 'LITELLM_API_KEY']`)
   * to forward those keys verbatim. The special wildcard `['*']`
   * preserves the legacy "forward everything" behavior; constructing
   * with that pattern logs a warning so callers notice they're opting
   * out of the secure default.
   */
  envAllowlist?: readonly string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Identifies this client to the MCP server during the initialize handshake. */
  clientInfo?: { name: string; version: string };
  /** Escape hatch for niche stdio config. Currently a narrow shape; widen as needs surface. */
  spawnOpts?: SpawnOptionsLite;
}

const DEFAULT_CLIENT_INFO = { name: '@ctkadvisors/mcp-tool-provider', version: '0.0.0' };

/**
 * Keys the SDK's `getDefaultEnvironment()` always inherits when an
 * `env` map is passed to `StdioClientTransport`. Mirrored here so
 * `ensureConnected()` can mask them when the consumer hasn't
 * allowlisted them. Source: `@modelcontextprotocol/sdk` →
 * `dist/esm/client/stdio.js` → `DEFAULT_INHERITED_ENV_VARS`.
 *
 * If the SDK's list grows in a future version we'd start leaking
 * those new keys; that's a known, accepted trade-off — the alternative
 * is a private fork of the transport.
 */
const SDK_SAFE_INHERIT_KEYS = [
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  // Windows
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERNAME',
  'USERPROFILE',
  'PROGRAMFILES',
] as const;

export class McpToolProvider implements ToolProvider {
  public readonly id: string;
  private readonly command: string;
  private readonly spawnArgs: string[];
  private readonly envOverride?: Record<string, string>;
  private readonly envAllowlist: readonly string[];
  private readonly cwd?: string;
  private readonly clientInfo: { name: string; version: string };
  private client: Client | null = null;
  private toolsCache: ToolDescriptor[] | null = null;
  private closed = false;

  constructor(opts: McpToolProviderOptions) {
    if (!opts.command || typeof opts.command !== 'string') {
      throw new InvalidConfigError('command', 'must be a non-empty string');
    }
    this.id = opts.id ?? 'mcp-stdio';
    this.command = opts.command;
    this.spawnArgs = opts.args ?? [];
    if (opts.env !== undefined) this.envOverride = opts.env;
    this.envAllowlist = opts.envAllowlist ?? [];
    if (this.envAllowlist.length === 1 && this.envAllowlist[0] === '*') {
      // WS-A: warn loudly when callers opt out of the secure default.
      console.warn(
        `[mcp-tool-provider] McpToolProvider(id=${this.id}) constructed with envAllowlist:['*'] — ` +
          'forwarding ALL of process.env to the MCP subprocess. This is the legacy/back-compat ' +
          'mode; for production prefer an explicit allowlist of env keys (or pass them via `env`).',
      );
    }
    if (opts.cwd !== undefined) this.cwd = opts.cwd;
    this.clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
  }

  async describeTools(ctx?: ToolInvocationContext): Promise<ToolDescriptor[]> {
    if (this.toolsCache !== null) return this.toolsCache;

    // WS-G — pre-fetch abort guard mirrors `executeTool`. If the run was
    // cancelled before we even spawned the subprocess, surface the abort
    // immediately instead of paying for the spawn + initialize round-trip.
    const abortSignal = ctx?.abortSignal;
    if (abortSignal?.aborted) {
      throw new McpToolProviderAbortError();
    }

    const client = await this.ensureConnected();
    let listed;
    try {
      // Forward the run's AbortSignal into the SDK's `RequestOptions`
      // so a slow MCP server can't pin tools/list. The SDK's default
      // 60s `RequestTimeout` still applies as a safety net; consumers
      // wanting tighter bounds wire it via the signal.
      listed =
        abortSignal !== undefined
          ? await client.listTools(undefined, { signal: abortSignal })
          : await client.listTools();
    } catch (err) {
      // If the abort fired mid-RPC the SDK raises RequestTimeout, which
      // classifyMcpError maps to McpToolProviderAbortError when
      // signalAborted=true.
      throw classifyMcpError(err, abortSignal?.aborted === true);
    }
    const descriptors: ToolDescriptor[] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
    }));
    this.toolsCache = descriptors;
    return descriptors;
  }

  async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
    // Pre-fetch abort guard (mirror Phase 4 client.ts WR-03 / Phase 5 http-tool-provider).
    if (ctx?.abortSignal?.aborted) {
      throw new McpToolProviderAbortError();
    }
    const client = await this.ensureConnected();
    let raw;
    try {
      raw = await client.callTool(
        { name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> },
        CallToolResultSchema,
        // CONTEXT D-22: providers do NOT own timeout policy — cancellation is
        // exclusively via the consumer's AbortSignal. We do NOT pass `timeout: 0`
        // (RESEARCH was wrong; SDK's `setTimeout(fn, 0)` fires on next tick,
        // immediately raising RequestTimeout). The SDK's 60s default is left in
        // place as a safety net; consumers wanting tighter or longer bounds
        // wire `setTimeout(() => controller.abort(), N)` at the call site.
        { signal: ctx.abortSignal },
      );
    } catch (err) {
      throw classifyMcpError(err, ctx.abortSignal.aborted);
    }
    return mapMcpResultToToolResult(raw as Parameters<typeof mapMcpResultToToolResult>[0]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client?.close();
    } catch {
      // best-effort close; subprocess may have already exited
    }
    this.client = null;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.closed) {
      throw new McpToolProviderSubprocessError('provider is closed');
    }
    if (this.client !== null) return this.client;

    // WS-A + D-14: env merge. Allowlist gate (default empty = forward
    // nothing from process.env; consumer-provided `env` is the only
    // input). The legacy "forward everything" mode is reachable via
    // `envAllowlist: ['*']` (constructor logs a warning).
    //
    // Note on SDK behavior: StdioClientTransport ALWAYS prepends a
    // hard-coded "safe inherit" set (HOME, PATH, USER, ...) when the
    // caller passes an `env` map. To honor a strict allowlist (and
    // make the secure default actually withhold those keys), we always
    // pass an `env` map AND we explicitly clear any safe-inherit key
    // that the allowlist doesn't list — the empty-string entries
    // override the SDK's defaults at the spawn boundary. The wildcard
    // mode skips this (the SDK baseline is fine when forwarding
    // everything).
    const wildcardMode = this.envAllowlist.length === 1 && this.envAllowlist[0] === '*';
    const inheritedEnv = filterProcessEnv(this.envAllowlist);
    let mergedEnv: Record<string, string> | undefined;
    if (wildcardMode) {
      mergedEnv = { ...inheritedEnv, ...(this.envOverride ?? {}) };
    } else {
      // Force the SDK's safe-inherit keys to '' unless the allowlist
      // (or the user's `env`) includes them.
      const hardCleared: Record<string, string> = {};
      for (const k of SDK_SAFE_INHERIT_KEYS) {
        if (!(k in inheritedEnv) && !(this.envOverride !== undefined && k in this.envOverride)) {
          hardCleared[k] = '';
        }
      }
      mergedEnv = { ...hardCleared, ...inheritedEnv, ...(this.envOverride ?? {}) };
    }

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.spawnArgs,
      ...(mergedEnv !== undefined && { env: mergedEnv }),
      ...(this.cwd !== undefined && { cwd: this.cwd }),
      stderr: 'pipe', // RESEARCH: 'inherit' default is noisy in tests
    });
    const client = new Client(this.clientInfo, { capabilities: {} });

    // D-18: invalidate-only on notifications/tools/list_changed (Pattern A).
    // SDK schema verified at packages/mcp-tool-provider/node_modules/
    // @modelcontextprotocol/sdk/dist/esm/types.d.ts:
    //   `export declare const ToolListChangedNotificationSchema: z.ZodObject<...>`
    // Plan checker forbids type-erasing casts — the imported Zod schema
    // already structurally satisfies setNotificationHandler's first argument.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.toolsCache = null;
    });

    try {
      await client.connect(transport);
    } catch (err) {
      throw new McpToolProviderSubprocessError(err instanceof Error ? err.message : String(err));
    }
    this.client = client;
    return client;
  }
}

/**
 * Classify SDK throws into the kernel ToolProviderError family.
 * Per RESEARCH §Mapping table lines 143-152.
 */
// Local numeric mirrors of the SDK's `ErrorCode` enum members we branch on.
// Two reasons to mirror as `const number` instead of comparing `err.code` (typed
// `number`) directly against `ErrorCode.X` (a numeric enum literal):
//   1. `@typescript-eslint/no-unsafe-enum-comparison` flags `number === Enum.X`
//      because the LHS is not typed as the enum.
//   2. An explicit `(ErrorCode.X as number)` cast trips
//      `@typescript-eslint/no-unnecessary-type-assertion` (the enum literal
//      already widens to number in this position).
// Local constants thread the needle: we still source-of-truth from the SDK
// enum, but the comparison sites use plain `number === number`.
const MCP_ERROR_REQUEST_TIMEOUT: number = ErrorCode.RequestTimeout;
const MCP_ERROR_CONNECTION_CLOSED: number = ErrorCode.ConnectionClosed;

/**
 * Classify SDK throws into the kernel ToolProviderError family.
 * Per RESEARCH §Mapping table lines 143-152.
 *
 * Exported (with underscore prefix to signal "internal-use") for direct
 * unit-testing — the production-path branches (ConnectionClosed, JSON-RPC
 * codes, signal-aborted RequestTimeout) are otherwise hard to hit without
 * mocking the entire SDK Client surface. Not re-exported via the barrel.
 */
export function _classifyMcpErrorForTests(err: unknown, signalAborted: boolean): Error {
  return classifyMcpError(err, signalAborted);
}

function classifyMcpError(err: unknown, signalAborted: boolean): Error {
  if (err instanceof McpError) {
    if (err.code === MCP_ERROR_REQUEST_TIMEOUT) {
      return signalAborted
        ? new McpToolProviderAbortError()
        : new McpToolProviderProtocolError(err.message);
    }
    if (err.code === MCP_ERROR_CONNECTION_CLOSED) {
      return new McpToolProviderSubprocessError(err.message);
    }
    return new McpToolProviderProtocolError(err.message);
  }
  return new McpToolProviderSubprocessError(err instanceof Error ? err.message : String(err));
}

/**
 * Filter `process.env` against an allowlist.
 *
 * - Empty allowlist (the secure default) → returns `{}`.
 * - Allowlist containing `'*'` → returns every defined entry of
 *   `process.env` (legacy back-compat mode; constructor logs a warning).
 * - Otherwise → returns only the listed keys that are defined.
 *
 * Exported (with underscore prefix) for direct testability.
 */
export function _filterProcessEnvForTests(allowlist: readonly string[]): Record<string, string> {
  return filterProcessEnv(allowlist);
}

function filterProcessEnv(allowlist: readonly string[]): Record<string, string> {
  if (allowlist.length === 0) return {};
  const out: Record<string, string> = {};
  if (allowlist.length === 1 && allowlist[0] === '*') {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  for (const key of allowlist) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}
