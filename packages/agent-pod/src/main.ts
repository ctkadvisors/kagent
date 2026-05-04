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

import {
  StdoutSink,
  buildTraceparentFromRunId,
  isOtelEnabled,
  OtelTraceSink,
  parseTraceparent,
  setupOtelExporter,
} from '@kagent/trace-sinks';
import type { TraceSink } from '@kagent/agent-loop';

import type { PodConfig } from './env.js';
import { parseEnv } from './env.js';
import type { RunResult } from './runner.js';
import type { ToolProvider } from '@kagent/agent-loop';
import { InProcessToolProvider } from '@kagent/in-process-tool-provider';

import { definePublishEvent } from './builtin-tools-publish.js';
import { defineGetMyContext } from './builtin-tools.js';
import { defineSpawnChildTask } from './builtin-tools-spawn.js';
import { defineEnsureAgentFromTemplate } from './builtin-tools-template.js';
import { defineWaitForChildTask, defineWaitForChildrenAll } from './builtin-tools-wait.js';
import { createInClusterK8sTaskCreator } from './k8s-task-creator.js';
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
  //
  // The sink takes per-run metadata (`runContext`) so Langfuse renders
  // each trace with a stable agent + task identity, and a content
  // capture policy (`contentMode`) so production prompts don't ship
  // unconditionally. Both come from the operator-injected env via
  // PodConfig — see `env.ts` for the env-var contract.
  const sinks: TraceSink[] = [new StdoutSink()];
  let otelShutdown: (() => Promise<void>) | undefined;
  if (isOtelEnabled(process.env)) {
    const { tracer, shutdown } = await setupOtelExporter({
      serviceName: `kagent-agent-pod/${config.agentName}`,
    });
    // v0.1.11 — when the operator threaded `OTEL_TRACEPARENT` (which
    // it does when the parent agent-pod stamped
    // `runConfig.traceparent` on this child task), parse it into a
    // remote parent SpanContext for OtelTraceSink so the child's
    // agent.run span lands as a real child of the parent's span. When
    // unset / malformed, fall through to the deterministic-from-runId
    // path — root tasks keep their own root trace.
    const inheritedParent = parseInheritedParentSpanContext(process.env);
    sinks.push(
      new OtelTraceSink({
        tracer,
        runContext: {
          agentName: config.agentName,
          taskUid: config.taskId,
          taskName: config.taskName,
          namespace: config.taskNamespace,
          ...(config.agentSpec.sandboxProfile !== undefined && {
            sandboxProfile: config.agentSpec.sandboxProfile,
          }),
        },
        contentMode: config.traceContentMode,
        ...(inheritedParent !== undefined && { parentSpanContext: inheritedParent }),
      }),
    );
    otelShutdown = shutdown;
    console.log(
      `[kagent-agent-pod] OTel exporter wired → ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '(default)'} (contentMode=${config.traceContentMode})${inheritedParent !== undefined ? ` (parent traceId=${inheritedParent.traceId})` : ''}`,
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

  // WS-K + WS-L — wire substrate task-graph tools when the flag is on.
  // Default-OFF per AGENT-SELF-SERVICE.md §11 Q5 — opt-in via Helm
  // value `agentPod.spawnChild.enabled` flipping
  // `KAGENT_SPAWN_CHILD_ENABLED=true`. spawn AND wait tools share the
  // same kill switch — they're useless apart (spawn without wait =
  // fire-and-forget; wait without spawn = nothing to wait on). The
  // per-tool guardrails (allowedChildAgents, concurrent cap, timeout
  // clamp) are the application-layer trust boundary; the env knob is
  // the operator-layer kill switch.
  const spawnEnabled = process.env.KAGENT_SPAWN_CHILD_ENABLED === 'true';
  let substrateTools: ToolProvider | undefined;
  if (spawnEnabled) {
    const k8s = createInClusterK8sTaskCreator();
    const parent = {
      uid: config.taskId,
      name: config.taskName,
      namespace: config.taskNamespace,
      // v0.1.9 — thread this task's depth so K8sTaskCreator can stamp
      // `kagent.knuteson.io/task-depth=<depth + 1>` on each spawned
      // child. The cap is enforced in the spawn tool itself
      // (defineSpawnChildTask) BEFORE we get here on a refused call.
      depth: config.taskDepth,
    };
    // Compute remaining wall-clock budget against the runConfig
    // timeout so child timeouts get clamped to "what the parent could
    // possibly outlive". The parent's own Job has the same
    // activeDeadlineSeconds; this just keeps spawned children + wait
    // calls from requesting more than the parent has left.
    const remainingBudgetSeconds: (() => number | undefined) | undefined =
      config.taskSpec.runConfig?.timeoutSeconds !== undefined
        ? ((startMs: number, totalSec: number) => () => {
            const elapsedSec = (Date.now() - startMs) / 1000;
            return Math.max(0, totalSec - elapsedSec);
          })(Date.now(), config.taskSpec.runConfig.timeoutSeconds)
        : undefined;
    // v0.1.11 — when OTel is wired, build a `getTraceparent` callback
    // the spawn tool stamps onto child task specs.
    const getTraceparent: (() => string) | undefined = isOtelEnabled(process.env)
      ? buildSpawnTraceparentGetter(config.taskId)
      : undefined;
    // v0.1.9 — cluster-level depth cap. Operator forwards
    // `KAGENT_AGENT_POD_MAX_DEPTH` from its own env (Helm value
    // `agentPod.maxDepth`, default 4) so the in-pod tool refuses
    // before issuing a K8s create.
    const maxDepthRaw = process.env.KAGENT_AGENT_POD_MAX_DEPTH;
    const maxDepthParsed =
      typeof maxDepthRaw === 'string' && maxDepthRaw.length > 0
        ? Number.parseInt(maxDepthRaw, 10)
        : Number.NaN;
    const maxDepth =
      Number.isInteger(maxDepthParsed) && maxDepthParsed >= 0 ? maxDepthParsed : undefined;

    const spawnDefs = defineSpawnChildTask({
      parent,
      parentAgentName: config.agentName,
      parentAgentSpec: config.agentSpec,
      k8s,
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
      ...(getTraceparent !== undefined && { getTraceparent }),
      ...(maxDepth !== undefined && { maxDepth }),
    });
    const waitChildDef = defineWaitForChildTask({
      parent,
      k8s,
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
    });
    const waitAllDef = defineWaitForChildrenAll({
      parent,
      k8s,
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
    });
    // v0.1.9 — get_my_context. Pure introspection, shares the same
    // remainingBudgetSeconds callback as spawn_child_task so both
    // tools agree on what's left.
    const ctxDef = defineGetMyContext({
      podConfig: config,
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
    });
    const subTools = [spawnDefs, waitChildDef, waitAllDef, ctxDef];
    // WS-M — append the template tool when the operator's
    // template-server URL was injected. Trust boundary: cluster-internal
    // network only (the operator Service is ClusterIP). Tool errors
    // surface as `policy_denied:` to the LLM, identical shape to
    // spawn_child's allowlist refusals.
    const templateServerUrl = process.env.KAGENT_TEMPLATE_SERVER_URL;
    if (typeof templateServerUrl === 'string' && templateServerUrl.length > 0) {
      subTools.push(
        defineEnsureAgentFromTemplate({
          serverUrl: templateServerUrl,
          createdByTaskUid: config.taskId,
        }),
      );
      console.log(
        `[kagent-agent-pod] template tool ENABLED → ${templateServerUrl} (ensure_agent_from_template)`,
      );
    }
    substrateTools = new InProcessToolProvider({
      id: 'kagent-substrate',
      tools: subTools,
    });
    console.log('[kagent-agent-pod] substrate tools ENABLED (spawn_child_task + wait_*)');
  }

  // === Wave 3 — Events ===
  // `publish_event` built-in tool. Wired only when the operator
  // threaded `KAGENT_EVENTS_NATS_URL` AND the Agent declares at
  // least one `publishes[]` entry. The cap-claim gate (publishClaims)
  // is sourced from the Agent spec's `capabilityClaims.publish` —
  // mirrors the design where the Wave 2 cap-issuer wiring is the
  // long-term path but the Agent spec carries the shadow until
  // every pod has a verified bundle mounted.
  let eventsTools: ToolProvider | undefined;
  const eventsNatsUrl = process.env.KAGENT_EVENTS_NATS_URL;
  const declaredPublishes = config.agentSpec.publishes ?? [];
  if (
    typeof eventsNatsUrl === 'string' &&
    eventsNatsUrl.length > 0 &&
    declaredPublishes.length > 0
  ) {
    const eventsModule = await import('@kagent/events');
    const declared = new Set<string>(declaredPublishes.map((p) => p.topic));
    const claims = config.agentSpec.capabilityClaims as
      | { readonly publish?: readonly string[] }
      | undefined;
    const publishClaims = claims?.publish;
    const publisher = new eventsModule.EventPublisher({
      source: `kagent.knuteson.io/agent-pod/${config.agentName}/${config.taskId}`,
      ...(publishClaims !== undefined && { publishClaims }),
    });
    await publisher.connect(eventsNatsUrl).catch((err: unknown) => {
      console.warn(
        `[kagent-agent-pod] publish_event NATS connect failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // Cap bundle: in this release the Wave 2 issuer-controller wiring
    // is still landing; we synthesize a minimal bundle from the
    // shadow-claim shape on the Agent spec so publish_event has the
    // gate it needs. The spawn-tool already follows the same pattern
    // (its `parentCapability` arg is optional pending issuer wiring).
    const fallbackBundle =
      publishClaims !== undefined
        ? {
            iss: 'kagent.knuteson.io/operator',
            sub: `task-uid:${config.taskId}`,
            aud: ['kagent-substrate'],
            exp: Math.floor(Date.now() / 1000) + 3600,
            jti: `pod-${config.taskId.slice(0, 8)}`,
            claims: { publish: publishClaims },
          }
        : undefined;
    const publishDef = definePublishEvent({
      publisher,
      capabilityBundle: fallbackBundle,
      declaredPublishes: declared,
    });
    eventsTools = new InProcessToolProvider({
      id: 'kagent-events',
      tools: [publishDef],
    });
    console.log(
      `[kagent-agent-pod] publish_event tool ENABLED (topics=[${Array.from(declared).join(', ')}])`,
    );
  }

  // v0.1.6 — Langfuse-managed prompt fetcher. Wired only when the
  // operator threaded KAGENT_LANGFUSE_HOST + creds (chart values
  // langfuse.{enabled,host,publicKeySecret,secretKeySecret}). Agents
  // with `systemPromptRef` boot-fail without this; agents with
  // literal `systemPrompt` are unaffected.
  const langfuseFetcher = buildLangfusePromptFetcher(process.env);
  if (langfuseFetcher !== undefined) {
    console.log(
      `[kagent-agent-pod] Langfuse prompt fetcher ENABLED → ${process.env.KAGENT_LANGFUSE_HOST ?? '<unset>'}`,
    );
  }

  let result: RunResult;
  try {
    result = await runAgentTask(config, {
      sinks,
      signal: shutdownController.signal,
      ...(substrateTools !== undefined && { spawnTools: substrateTools }),
      ...(eventsTools !== undefined && { eventsTools }),
      ...(langfuseFetcher !== undefined && { fetchPrompt: langfuseFetcher }),
    });
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

/**
 * v0.1.11 — build the spawn-side traceparent getter.
 *
 * The spawn tool's `getTraceparent` callback returns the parent
 * agent-pod's current W3C traceparent header value at the moment of
 * spawn. We compose it deterministically from the parent's task UID
 * via `buildTraceparentFromRunId(taskId)`, which matches exactly the
 * trace ID + root span ID that this pod's OtelTraceSink uses for its
 * own `agent.run` span. End effect: the child's OtelTraceSink seeds
 * its root span context to the parent's span — child trace tree
 * becomes a child of the parent's, not a sibling.
 *
 * Cheap pure helper — exported here so tests can hit it without
 * booting the full main loop.
 */
export function buildSpawnTraceparentGetter(taskId: string): () => string {
  return () => buildTraceparentFromRunId(taskId);
}

/**
 * v0.1.11 — read `OTEL_TRACEPARENT` out of the environment and parse
 * it into a `{traceId, spanId}` shape suitable for
 * `OtelTraceSinkOptions.parentSpanContext`.
 *
 * Returns `undefined` when:
 *   - The env var is absent or empty (root tasks; pre-v0.1.11 behavior).
 *   - The env var fails W3C v00 validation. We log a warning instead
 *     of throwing so a malformed traceparent can never gate a child
 *     task from running — the trace just degrades to "no parent
 *     context" (sibling trace), the same outcome as if the env wasn't
 *     set. Hard-fail-on-mis-stamp would be a footgun the substrate
 *     doesn't get to make for the child.
 */
export function parseInheritedParentSpanContext(
  env: Readonly<Record<string, string | undefined>>,
): { readonly traceId: string; readonly spanId: string } | undefined {
  const raw = env.OTEL_TRACEPARENT;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = parseTraceparent(raw);
  if (parsed === undefined) {
    console.warn(
      `[kagent-agent-pod] OTEL_TRACEPARENT="${raw}" is not a valid W3C v00 traceparent; ignoring (child will be its own root trace)`,
    );
    return undefined;
  }
  return { traceId: parsed.traceId, spanId: parsed.spanId };
}

/**
 * v0.1.6 — Build a Langfuse prompt fetcher from process.env.
 *
 * Returns `undefined` when KAGENT_LANGFUSE_HOST is unset (so
 * `runner.resolveSystemPrompt` falls through cleanly for agents that
 * don't use Langfuse). Returns a function when host + creds are all
 * present.
 *
 * Calls Langfuse's v2 prompt API:
 *   GET {host}/api/public/v2/prompts/{name}[?version=N]
 *   Authorization: Basic base64(public:secret)
 *
 * Response body:
 *   { id, name, version, type: 'text'|'chat', prompt: string|object, ... }
 *
 * v1 only handles `type: 'text'` prompts (single-string body).
 * Chat-typed prompts throw — agent system prompts are text by convention.
 */
export function buildLangfusePromptFetcher(
  env: Readonly<Record<string, string | undefined>>,
): ((name: string, version?: number) => Promise<string>) | undefined {
  const host = env.KAGENT_LANGFUSE_HOST;
  const publicKey = env.KAGENT_LANGFUSE_PUBLIC_KEY;
  const secretKey = env.KAGENT_LANGFUSE_SECRET_KEY;
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    typeof publicKey !== 'string' ||
    publicKey.length === 0 ||
    typeof secretKey !== 'string' ||
    secretKey.length === 0
  ) {
    return undefined;
  }

  const basicAuth = Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64');
  const baseUrl = host.replace(/\/+$/, '');

  return async (name: string, version?: number): Promise<string> => {
    const qs = version !== undefined ? `?version=${String(version)}` : '';
    const url = `${baseUrl}/api/public/v2/prompts/${encodeURIComponent(name)}${qs}`;
    const res = await fetch(url, {
      headers: {
        authorization: `Basic ${basicAuth}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(
        `Langfuse GET ${url} returned ${String(res.status)}: ${await res.text().catch(() => '<no body>')}`,
      );
    }
    const body = (await res.json()) as { type?: string; prompt?: unknown };
    if (body.type !== 'text') {
      throw new Error(
        `Langfuse prompt "${name}" has type="${body.type ?? 'unknown'}"; only text prompts are supported in v0.1.6`,
      );
    }
    if (typeof body.prompt !== 'string') {
      throw new Error(`Langfuse prompt "${name}" body is not a string (got ${typeof body.prompt})`);
    }
    return body.prompt;
  };
}
