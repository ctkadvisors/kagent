/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `kagent` — the CLI binary entry point. Argv parsing is hand-rolled
 * (no commander/yargs dep) — at this surface size the savings aren't
 * worth the dep. Subcommands so far:
 *
 *   kagent submit <agent> "<prompt>" [--namespace ns] [--timeout sec]
 *                                    [--name name] [--wait] [--json]
 *
 * Future: kagent list, kagent get, kagent agents, kagent template.
 */

import { submitTask } from './commands/submit.js';

interface ParsedArgs {
  readonly subcommand?: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let subcommand: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (subcommand === undefined) {
      subcommand = arg;
    } else {
      positionals.push(arg);
    }
  }
  return {
    ...(subcommand !== undefined && { subcommand }),
    positionals,
    flags,
  };
}

function printUsage(): void {
  console.log(`kagent — CLI for the kagent agent farm

Usage:
  kagent submit <agent> "<prompt>" [options]

Options for submit:
  --namespace <ns>      Override the namespace (default: kubeconfig's current-context namespace)
  --name <name>         Override the AgentTask name (default: cli-<rand8>)
  --timeout <seconds>   Set runConfig.timeoutSeconds (1..86400)
  --wait                Block until the task reaches Completed or Failed
  --json                Emit JSON to stdout instead of human-readable lines

Auth:
  Uses kubeconfig (KUBECONFIG / ~/.kube/config) — same as kubectl.

Examples:
  kagent submit smoke-test "What is etcd in one sentence?"
  kagent submit smoke-test "Research X" --timeout 600 --wait
  kagent submit smoke-test "..." --json
`);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.subcommand === undefined || parsed.flags.help === true || parsed.flags.h === true) {
    printUsage();
    return parsed.subcommand === undefined ? 1 : 0;
  }

  switch (parsed.subcommand) {
    case 'submit': {
      const targetAgent = parsed.positionals[0];
      const prompt = parsed.positionals[1];
      if (targetAgent === undefined || prompt === undefined) {
        console.error('error: usage: kagent submit <agent> "<prompt>"');
        return 1;
      }
      const namespaceFlag = parsed.flags.namespace;
      const nameFlag = parsed.flags.name;
      const timeoutFlag = parsed.flags.timeout;
      const wait = parsed.flags.wait === true;
      const json = parsed.flags.json === true;

      try {
        const result = await submitTask({
          targetAgent,
          prompt,
          ...(typeof namespaceFlag === 'string' && { namespace: namespaceFlag }),
          ...(typeof nameFlag === 'string' && { name: nameFlag }),
          ...(typeof timeoutFlag === 'string' && {
            timeoutSeconds: Number.parseInt(timeoutFlag, 10),
          }),
          wait,
          json,
        });
        return result.exitCode;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`error: ${msg}`);
        return 1;
      }
    }
    default: {
      console.error(`error: unknown subcommand "${parsed.subcommand}"`);
      printUsage();
      return 1;
    }
  }
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('fatal:', err);
      process.exit(1);
    });
}
