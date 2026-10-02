# Agent-loop runtime import boundary

The credentialed tool gateway loads `@kagent/agent-loop/kernel`. Its provider
registry and HTTP/MCP dependencies use that same entry point. It exports the
registry, provider contracts, shared error classes and LLM contracts; it never
loads the executor, runtime barrel, detectors or trace implementation.

The protected source closure is:

- `packages/agent-loop/src/kernel.ts`
- `packages/agent-loop/src/registry.ts`
- `packages/agent-loop/src/tool-provider.ts`
- `packages/agent-loop/src/errors.ts`
- `packages/agent-loop/src/llm-client.ts`
- `packages/agent-loop/src/types.ts`

The package manifest, public index and build/test/lint configuration also stay
protected. The gateway, HTTP provider and MCP provider packages remain outside
the fleet's writable grant. A new kernel dependency must join the protected
closure before a credentialed process imports it.

Gateway imports are `external-providers.ts`, `http-server.ts` and the type-only
`fleet-run-tool.ts`. Its transitive provider imports are HTTP `provider.ts` and
`path-template.ts`, plus MCP `provider.ts` and type-only `content-mapper.ts`.
All resolve to the kernel. The production export rewrite maps `./kernel` to
`./dist/kernel.js` through the existing recursive image-build helper.

`runtime-import-boundary.test.ts` copies the real packages into a temporary
workspace, makes every non-kernel agent-loop source module throw on evaluation,
and launches a separate Node process with actual package resolution. It imports
the gateway HTTP server and external provider registry and exercises an empty
registry. An accidental runtime import fails even when the imported value is
otherwise unused.

The agent pod deliberately imports the full runtime and runs with the current
task's capability. `trace-sinks` has production imports only from agent-pod
`main.ts` and `runner.ts`. `agent-workflow-runtime` has no production imports in
the current workspace packages; operator mentions describe CRD data, without
loading its executable code. Neither statement widens operator, event,
supervision, trigger, publisher or evaluator authority.
