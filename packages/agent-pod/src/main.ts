/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Agent-pod entrypoint. Boots once per AgentTask:
 *
 *   1. Parse env (operator-injected) into a PodConfig.
 *   2. (Optional) initialize OTel exporter pointed at Langfuse.
 *   3. Run the agent loop against LiteLLM.
 *   4. Patch AgentTask.status via the K8s API.
 *   5. Flush OTel + exit (Job controller GCs the Pod after ttl).
 *
 * Designed for Bun (`bun src/main.ts`) — see Dockerfile in this dir.
 */

import { StdoutSink, isOtelEnabled, OtelTraceSink, setupOtelExporter } from '@kagent/trace-sinks';
import type { TraceSink } from '@kagent/agent-loop';

import { parseEnv } from './env.js';
import { runAgentTask } from './runner.js';
import { buildStatusPatch, makeCustomObjectsApi, writeStatus } from './status.js';

async function main(): Promise<void> {
  const config = parseEnv(process.env);
  console.log(
    `[kagent-agent-pod] boot ${config.taskNamespace}/${config.taskName} ` +
      `agent=${config.agentName} model=${config.agentSpec.model}`,
  );

  // OTel exporter — pointed at Langfuse via OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.
  // When unset, we silently skip OTel and only use StdoutSink. Keeps local
  // dev silent without forcing the operator to thread an opt-out flag.
  const sinks: TraceSink[] = [new StdoutSink()];
  let otelShutdown: (() => Promise<void>) | undefined;
  if (isOtelEnabled(process.env)) {
    const { tracer, shutdown } = await setupOtelExporter({
      serviceName: `kagent-agent-pod/${config.agentName}`,
    });
    sinks.push(new OtelTraceSink({ tracer }));
    otelShutdown = shutdown;
    console.log(
      `[kagent-agent-pod] OTel exporter wired → ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '(default)'}`,
    );
  }

  let result;
  try {
    result = await runAgentTask(config, { sinks });
  } catch (err) {
    // Hard failure inside the runner (e.g. cannot reach LiteLLM, fatal
    // executor error). Still try to patch status so the operator sees
    // a terminal phase rather than a perpetually-Pending task.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[kagent-agent-pod] runner threw:', message);
    const api = makeCustomObjectsApi();
    await writeStatus(
      config,
      {
        phase: 'Failed',
        error: `runner threw: ${message}`,
        completedAt: new Date().toISOString(),
        structuralVerdict: { suspicious: [] },
      },
      api,
    );
    if (otelShutdown !== undefined) await otelShutdown();
    process.exit(1);
  }

  console.log(
    `[kagent-agent-pod] loop done status=${result.status} flags=[${result.flags.join(',')}] ` +
      `inputTokens=${result.budget.cumulativeInputTokens} outputTokens=${result.budget.cumulativeOutputTokens}`,
  );

  const api = makeCustomObjectsApi();
  await writeStatus(config, buildStatusPatch(result, new Date()), api);

  if (otelShutdown !== undefined) {
    await otelShutdown();
    console.log('[kagent-agent-pod] OTel flushed');
  }

  console.log(`[kagent-agent-pod] status patched, exiting`);
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[kagent-agent-pod] fatal:', err);
    process.exit(1);
  });
}
