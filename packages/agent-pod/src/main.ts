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
 * Runs under Node 22 + tsx (`node --import tsx/esm src/main.ts`); the
 * Dockerfile in this dir bakes the same entrypoint. Bun was the v0.1
 * target but @kubernetes/client-node's TLS path rejects K3s
 * self-signed CAs under Bun 1.1; revisit when undici/TLS parity lands.
 *
 * SIGTERM/SIGINT handling (WS-G): signals are captured and translated
 * into an `AbortController.abort()` on the run's shutdown controller.
 * The executor's existing AbortSignal plumbing then unwinds the loop
 * with `status='cancelled'`, the runner returns, and main writes a
 * `Failed` status patch with `error: 'cancelled: SIGTERM received'`
 * before flushing OTel and exiting. Without this we'd be SIGKILLed by
 * the kubelet after `terminationGracePeriodSeconds` and the AgentTask
 * would stay pinned in `Dispatched`.
 */

import { StdoutSink, isOtelEnabled, OtelTraceSink, setupOtelExporter } from '@kagent/trace-sinks';
import type { TraceSink } from '@kagent/agent-loop';

import type { PodConfig } from './env.js';
import { parseEnv } from './env.js';
import type { RunResult } from './runner.js';
import { runAgentTask } from './runner.js';
import { buildStatusPatch, makeCustomObjectsApi, writeStatus } from './status.js';

/**
 * Internal shape that captures the steps the SIGTERM/SIGINT handler
 * must perform. Pure data — `buildShutdownPlan` returns it; main wires
 * the steps to real I/O. Splitting it out lets us unit-test the
 * orchestration without spawning a process.
 */
export interface ShutdownPlan {
  /** Signal name that fired (for logging). */
  readonly signalName: NodeJS.Signals;
  /** Whether the handler should actually do anything (false on re-entry). */
  readonly shouldRun: boolean;
}

/**
 * Decide what a SIGTERM/SIGINT handler should do given prior state.
 * Returns `shouldRun: false` on re-entry so multiple signals don't
 * trigger overlapping abort+patch sequences. Pure function — exported
 * for the unit test suite.
 */
export function buildShutdownPlan(
  signalName: NodeJS.Signals,
  alreadyShuttingDown: boolean,
): ShutdownPlan {
  return {
    signalName,
    shouldRun: !alreadyShuttingDown,
  };
}

/**
 * Build the "cancelled" RunResult shape that's written to AgentTask
 * status when a SIGTERM fires before the runner ever started (or the
 * runner threw mid-cancel). Mirrors the shape the runner would have
 * produced at `status='cancelled'`. Exported for unit tests.
 */
export function buildCancelledResult(config: PodConfig, signalName: NodeJS.Signals): RunResult {
  return {
    runId: config.taskId,
    status: 'cancelled',
    finalContent: null,
    flags: [],
    traces: [],
    budget: {
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUsd: null,
    },
    error: { message: `cancelled: ${signalName} received` },
  };
}

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

  // SIGTERM/SIGINT-driven shutdown controller. The handlers below call
  // `abort()`; the runner's executor sees the signal and unwinds its
  // loop with `status='cancelled'`. Re-entrant-safe via the
  // `alreadyShuttingDown` flag (kubelet sometimes sends multiple
  // signals during pod termination).
  const shutdownController = new AbortController();
  let alreadyShuttingDown = false;
  let shutdownSignal: NodeJS.Signals | undefined;

  const onSignal = (signal: NodeJS.Signals): void => {
    const plan = buildShutdownPlan(signal, alreadyShuttingDown);
    if (!plan.shouldRun) {
      console.log(
        `[kagent-agent-pod] received ${plan.signalName} during shutdown — ignoring (re-entry)`,
      );
      return;
    }
    alreadyShuttingDown = true;
    shutdownSignal = signal;
    console.log(
      `[kagent-agent-pod] received ${signal} — aborting executor + patching Failed/cancelled`,
    );
    shutdownController.abort();
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let result: RunResult;
  try {
    result = await runAgentTask(config, { sinks, signal: shutdownController.signal });
  } catch (err) {
    // If the runner threw because we already aborted, treat it as a
    // cancelled run rather than a runner-fatal failure — the user-
    // visible cause is the SIGTERM, not whatever surface the abort
    // tripped on its way out.
    if (shutdownController.signal.aborted) {
      console.log(
        `[kagent-agent-pod] runner unwound during shutdown (${shutdownSignal ?? 'abort'})`,
      );
      result = buildCancelledResult(config, shutdownSignal ?? 'SIGTERM');
    } else {
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
  }

  // Detach the signal handlers — past this point we're patching status
  // and flushing OTel; a second SIGTERM should not interrupt us.
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  console.log(
    `[kagent-agent-pod] loop done status=${result.status} flags=[${result.flags.join(',')}] ` +
      `inputTokens=${result.budget.cumulativeInputTokens} outputTokens=${result.budget.cumulativeOutputTokens}`,
  );

  const api = makeCustomObjectsApi();
  // When SIGTERM aborted us, override the status patch error message so
  // the operator-visible reason is "cancelled: SIGTERM received" instead
  // of `loop ended with status=cancelled`.
  if (alreadyShuttingDown && shutdownSignal !== undefined && result.status === 'cancelled') {
    const cancelledResult: RunResult = {
      ...result,
      error: { message: `cancelled: ${shutdownSignal} received` },
    };
    await writeStatus(config, buildStatusPatch(cancelledResult, new Date()), api);
  } else {
    await writeStatus(config, buildStatusPatch(result, new Date()), api);
  }

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
