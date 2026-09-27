/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `fleet.run_tool` — run a promoted playground tool at a pinned commit.
 *
 * The catalog's executable half (FLEET-AGENTS.md stage 2 in new_localai): a
 * promoted tool is a folder in the fleet's playground repository, pinned by
 * its own last commit. This tool fetches that folder at that sha from the
 * playground service (signed with the calling task's identity, like every
 * fleet.* call), writes it into the task's code workspace, runs the folder's
 * declared command with `sh -c`, and returns the exit status and bounded
 * output. The model never retypes the recipe; it calls one tool and reads
 * numbers. Execution happens in the task's code runner, wherever that runs.
 */

import { signedIdentityHeaders } from '@kagent/http-tool-provider';
import type { ToolResult } from '@kagent/agent-loop';
import type {
  ToolGatewayCodeRunner,
  ToolGatewayExternalHandler,
  ToolGatewayHandlerInput,
  ToolGatewayTaskIdentity,
} from './http-server.js';

export const FLEET_RUN_TOOL_NAME = 'fleet.run_tool';
const FOLDER = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{1,48}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 1_500_000;
const STDOUT_KEEP = 6000;
const STDERR_KEEP = 1500;
const TREE_MAX_BYTES = 8 * 1024 * 1024;
const ENVELOPE_MARK = '@@fleet.run_tool@@';

export interface FleetRunToolOptions {
  readonly playgroundUrl: string;
  readonly signingKey: string;
  readonly codeRunnerFor: (task: ToolGatewayTaskIdentity) => ToolGatewayCodeRunner;
  readonly fetch?: typeof globalThis.fetch;
}

export interface FleetRunToolArgs {
  readonly folder: string;
  readonly sha: string;
  readonly run: string;
  readonly timeoutMs?: number;
}

export const FLEET_RUN_TOOL_DESCRIPTOR = {
  name: FLEET_RUN_TOOL_NAME,
  description:
    'Run a promoted playground tool at its pinned commit: fetches the folder at that sha into your workspace, runs its command with sh -c, and returns {exit, stdout, stderr, timedOut}. Args: folder (YYYY-MM-DD-name), sha (40 hex), run (the command from promote.json), timeoutMs (default 900000).',
  inputSchema: {
    type: 'object',
    required: ['folder', 'sha', 'run'],
    properties: {
      folder: { type: 'string' },
      sha: { type: 'string' },
      run: { type: 'string' },
      timeoutMs: { type: 'number', minimum: 1000 },
    },
  },
} as const;

export function parseFleetRunToolArgs(args: unknown): FleetRunToolArgs | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (typeof a.folder !== 'string' || !FOLDER.test(a.folder)) return null;
  if (typeof a.sha !== 'string' || !SHA.test(a.sha)) return null;
  if (typeof a.run !== 'string' || a.run.trim().length === 0 || a.run.length > 200) return null;
  const out: FleetRunToolArgs = { folder: a.folder, sha: a.sha, run: a.run.trim() };
  if (typeof a.timeoutMs === 'number' && a.timeoutMs >= 1000) {
    return { ...out, timeoutMs: Math.min(a.timeoutMs, MAX_TIMEOUT_MS) };
  }
  return out;
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

export function defineFleetRunTool(options: FleetRunToolOptions): ToolGatewayExternalHandler {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.playgroundUrl.replace(/\/+$/, '');
  return async (input: ToolGatewayHandlerInput): Promise<ToolResult> => {
    const args = parseFleetRunToolArgs(input.call.args);
    if (args === null) {
      return errorResult(
        'invalid_args: fleet.run_tool needs folder (YYYY-MM-DD-name), sha (40 hex) and run (<=200 chars)',
      );
    }
    const url = `${base}/tree?folder=${encodeURIComponent(args.folder)}&sha=${args.sha}`;
    let tree: { files?: Record<string, unknown>; error?: unknown };
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: signedIdentityHeaders(options.signingKey, input.task, undefined),
        signal: input.request.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return errorResult(
          `playground refused the tree: HTTP ${response.status} ${text.slice(0, 300)}`,
        );
      }
      if (text.length > TREE_MAX_BYTES) return errorResult('playground tree exceeds 8 MiB');
      tree = JSON.parse(text) as { files?: Record<string, unknown> };
    } catch (err) {
      return errorResult(
        `playground unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const files = Object.entries(tree.files ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (files.length === 0)
      return errorResult(`no files in ${args.folder}@${args.sha.slice(0, 7)}`);
    const runner = options.codeRunnerFor(input.task);
    await runner.writeFiles(
      files.map(([path, content]) => ({ path: `${args.folder}/${path}`, content })),
    );
    // The runner's executeCommand admits an allowlist (node, python...) and not
    // `sh`; a promoted tool's command is arbitrary. Run it the way agent code
    // already does — a snippet in the same task workspace spawning `sh -c` —
    // and read one JSON envelope back. Same sandbox, same limits.
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const snippet = [
      "import { spawnSync } from 'node:child_process';",
      `const r = spawnSync('sh', ['-c', ${JSON.stringify(args.run)}], { cwd: ${JSON.stringify(args.folder)}, encoding: 'utf8', timeout: ${String(timeoutMs - 5000)}, maxBuffer: 16 * 1024 * 1024 });`,
      `process.stdout.write('\\n' + ${JSON.stringify(ENVELOPE_MARK)} + JSON.stringify({ status: r.status, signal: r.signal, stdout: (r.stdout || '').slice(0, ${String(STDOUT_KEEP)}), stderr: (r.stderr || '').slice(-${String(STDERR_KEEP)}) }));`,
    ].join('\n');
    const result = await runner.executeCode({ language: 'javascript', code: snippet, timeoutMs });
    const mark = result.stdout.lastIndexOf(ENVELOPE_MARK);
    if (mark < 0) {
      return errorResult(
        `the run produced no result envelope (exit ${String(result.exitCode)}, timedOut ${String(result.timedOut)}): ${result.stderr.slice(-600)}`,
      );
    }
    let envelope: { status: number | null; signal: string | null; stdout: string; stderr: string };
    try {
      envelope = JSON.parse(result.stdout.slice(mark + ENVELOPE_MARK.length)) as typeof envelope;
    } catch {
      return errorResult('the run produced an unreadable result envelope');
    }
    const exit = envelope.status ?? (envelope.signal !== null ? 124 : 2);
    return {
      content: JSON.stringify({
        folder: args.folder,
        sha: args.sha,
        run: args.run,
        exit,
        timedOut: envelope.signal === 'SIGTERM',
        stdout: envelope.stdout,
        stderr: envelope.stderr,
      }),
      isError: false,
      metadata: { exit },
    };
  };
}
