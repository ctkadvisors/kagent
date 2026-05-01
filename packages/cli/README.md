# @kagent/cli

`kagent` — CLI for the kagent agent farm. Wraps the same Kubernetes
API surface the workbench uses (POST AgentTask) so the same unit of
work can be created from YAML, GUI, or terminal.

## Install

```sh
# from the monorepo (development)
pnpm --filter @kagent/cli build
node packages/cli/dist/cli.js submit ...

# or run directly without build:
pnpm --filter @kagent/cli start submit ...
```

A `bin: kagent` entry is declared in `package.json`; `npm pack` /
`npm publish` produces a usable `kagent` binary on PATH.

## Auth

Uses kubeconfig — same as `kubectl`. `KUBECONFIG` env var or
`~/.kube/config`. The current-context namespace is the default
target namespace; override with `--namespace`.

## Submit a task

```sh
kagent submit <agent> "<prompt>" [options]

  --namespace <ns>      Override the namespace
  --name <name>         Override the AgentTask name (default: cli-<rand8>)
  --timeout <seconds>   Set runConfig.timeoutSeconds (1..86400)
  --wait                Block until the task reaches Completed or Failed
  --json                Emit JSON to stdout instead of human-readable lines

Exit codes:
  0  task created (and Completed if --wait)
  1  task created but Failed (only with --wait), or argv error
  2  --wait timed out before terminal phase
```

## Examples

```sh
# Fire and forget
kagent submit smoke-test "What is etcd in one sentence?"

# Wait for the result
kagent submit smoke-test "Research X" --timeout 600 --wait

# Machine-readable output for piping
kagent submit smoke-test "..." --json | jq .created.uid
```

## Embedding

`@kagent/cli` re-exports `submitTask`, `waitForTask`, and the
`KubeClient` factory so other Node tools (webhook handlers, scheduled
jobs) can reuse the submit logic without shelling out:

```ts
import { submitTask } from '@kagent/cli';

await submitTask({ targetAgent: 'smoke-test', prompt: '...', wait: true });
```
