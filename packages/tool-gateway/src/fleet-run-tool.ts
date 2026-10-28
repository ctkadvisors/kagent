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
import type { ToolResult } from '@kagent/agent-loop/kernel';
import type {
  ToolGatewayCodeRunner,
  ToolGatewayExternalHandler,
  ToolGatewayHandlerInput,
  ToolGatewayTaskIdentity,
} from './http-server.js';

export const FLEET_RUN_TOOL_NAME = 'fleet.run_tool';
export const FLEET_RUN_CAPABILITY_NAME = 'fleet.run_capability';
const FOLDER = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{1,48}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 1_500_000;
const STDOUT_KEEP = 6000;
const STDERR_KEEP = 1500;
const TREE_MAX_BYTES = 8 * 1024 * 1024;
const ENVELOPE_MARK = '@@fleet.run_tool@@';
// The command reaches sh through a workspace snippet, not argv. 200 rejected the
// delivery and verifier commands agents write (2026-10-13: 44 of 126 calls refused).
const RUN_MAX = 4000;

export interface FleetRunToolOptions {
  readonly playgroundUrl: string;
  readonly signingKey: string;
  readonly codeRunnerFor: (task: ToolGatewayTaskIdentity) => ToolGatewayCodeRunner;
  readonly fetch?: typeof globalThis.fetch;
  readonly catalogUrl?: string;
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

export const FLEET_RUN_CAPABILITY_DESCRIPTOR = {
  name: FLEET_RUN_CAPABILITY_NAME,
  description:
    'Use an accepted fleet capability by catalog template and expected pin. The gateway resolves its exact folder, SHA and command; do not retype or wrap a command. Returns the resolved binding, signed reference exit and actual domain exit/output. Nonzero can be a valid finding. Refresh the catalog if its revision changed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['template', 'sha'],
    properties: {
      template: { type: 'string', pattern: '^capability-[a-z0-9][a-z0-9-]{1,40}$' },
      sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
      revision: { type: 'integer', minimum: 1 },
    },
  },
} as const;

async function resolveCapability(
  input: ToolGatewayHandlerInput,
  options: FleetRunToolOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ args: FleetRunToolArgs; entry: Record<string, unknown> } | string> {
  const value = input.call.args;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'send template, sha and revision from the capability catalog';
  const wanted = value as Record<string, unknown>;
  if (
    Object.keys(wanted).some((key) => !['template', 'sha', 'revision'].includes(key)) ||
    typeof wanted.template !== 'string' ||
    !/^capability-[a-z0-9][a-z0-9-]{1,40}$/u.test(wanted.template) ||
    typeof wanted.sha !== 'string' ||
    !SHA.test(wanted.sha) ||
    ('revision' in wanted && (!Number.isInteger(wanted.revision) || Number(wanted.revision) < 1))
  )
    return 'invalid capability selection; commands and overrides are not accepted';
  try {
    const response = await fetchImpl(
      options.catalogUrl ?? 'http://report.fleet-authority.svc:8080/missions',
      { signal: AbortSignal.any([input.request.signal, AbortSignal.timeout(20_000)]) },
    );
    if (!response.ok) return `capability catalog unavailable: HTTP ${String(response.status)}`;
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return 'capability catalog exceeds response bound';
    const report = JSON.parse(text) as { catalog?: unknown };
    if (!Array.isArray(report.catalog)) return 'capability catalog unavailable';
    const entry = report.catalog.find(
      (row: unknown): row is Record<string, unknown> =>
        typeof row === 'object' &&
        row !== null &&
        !Array.isArray(row) &&
        (row as Record<string, unknown>).template === wanted.template &&
        (row as Record<string, unknown>).kind === 'capability',
    );
    if (entry === undefined) return 'capability is not accepted in the current catalog';
    if (entry.sha !== wanted.sha || entry.revision !== wanted.revision)
      return 'capability catalog revision changed; refresh its current invocation before use';
    const args = parseFleetRunToolArgs(entry);
    if (typeof args === 'string') return `invalid catalog binding: ${args}`;
    return { args, entry };
  } catch {
    return 'capability catalog unavailable; retain this task and retry with current evidence';
  }
}

/** The parsed args, or the one-line reason they are refused (naming the bad field). */
export function parseFleetRunToolArgs(args: unknown): FleetRunToolArgs | string {
  const a = (
    typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  if (typeof a.folder !== 'string' || !FOLDER.test(a.folder))
    return `folder must be YYYY-MM-DD-name, got ${JSON.stringify(a.folder ?? null)}`;
  if (typeof a.sha !== 'string' || !SHA.test(a.sha))
    return `sha must be the folder's 40-hex commit, got ${JSON.stringify(a.sha ?? null)}`;
  if (typeof a.run !== 'string' || a.run.trim().length === 0 || a.run.length > RUN_MAX)
    return `run must be a command of 1..${String(RUN_MAX)} chars, got ${typeof a.run === 'string' ? String(a.run.length) : 'none'}`;
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
    const resolved =
      input.call.name === FLEET_RUN_CAPABILITY_NAME
        ? await resolveCapability(input, options, fetchImpl)
        : undefined;
    if (typeof resolved === 'string') return errorResult(resolved);
    const args = resolved?.args ?? parseFleetRunToolArgs(input.call.args);
    if (typeof args === 'string') return errorResult(`invalid_args: fleet.run_tool ${args}`);
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
        ...(resolved === undefined
          ? {}
          : {
              template: resolved.entry.template,
              revision: resolved.entry.revision,
              accepted_at: resolved.entry.accepted_at,
              reference_exit: resolved.entry.reference_exit,
              verdict: resolved.entry.verdict,
            }),
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
