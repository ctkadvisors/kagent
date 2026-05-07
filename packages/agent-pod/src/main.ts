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

import { AuditPublisher, CAPABILITY_USED, makeEvent } from '@kagent/audit-events';
import {
  StdoutSink,
  buildTraceparentFromRunId,
  isOtelEnabled,
  OtelTraceSink,
  parseTraceparent,
  setupOtelExporter,
} from '@kagent/trace-sinks';
import type { RunBudget, TraceSink } from '@kagent/agent-loop';
import type { CapabilityBundle } from '@kagent/capability-types';

import type { PodConfig } from './env.js';
import { parseEnv } from './env.js';
import type { RunResult } from './runner.js';
import type { ToolProvider } from '@kagent/agent-loop';
import { InProcessToolProvider } from '@kagent/in-process-tool-provider';

import { defineBlackboardTools } from './builtin-tools.js';
import { definePublishEvent } from './builtin-tools-publish.js';
import { defineSpawnChildTask } from './builtin-tools-spawn.js';
import { defineEnsureAgentFromTemplate } from './builtin-tools-template.js';
import { defineWaitForChildTask, defineWaitForChildrenAll } from './builtin-tools-wait.js';
import { buildBlackboardClientFromEnv } from './blackboard-client.js';
import { loadCapabilityOptional } from './cap-consumer.js';
import { createInClusterK8sTaskCreator } from './k8s-task-creator.js';
import { runAgentTask } from './runner.js';
import { buildStatusPatch, makeCustomObjectsApi, writeStatus } from './status.js';

/**
 * Audit-rev2 M10 — milliseconds the SIGTERM grace flush waits before
 * forcibly writing a best-effort `Failed` status patch. Callers (the
 * shutdown handler) schedule the flush via `setTimeout(...).unref()`
 * so the timer doesn't prevent normal exit when the runner unwinds
 * before the deadline. 25_000 ms (25s) leaves margin under K8s's
 * default `terminationGracePeriodSeconds=30` so the patch lands
 * before SIGKILL fires. Exported for unit tests + downstream
 * consumers that want to coordinate similar deadlines.
 */
export const GRACE_FLUSH_DEADLINE_MS = 25_000;

/**
 * Audit-rev2 M10 — best-effort grace-flush implementation. Builds a
 * `phase: 'Failed'` status patch and writes it through the K8s status
 * API, swallowing any thrown errors. Called from the SIGTERM handler
 * when the runner hasn't unwound by `GRACE_FLUSH_DEADLINE_MS`. Pure
 * I/O wrapper — exported so the unit-test suite can drive the same
 * code path without spawning a process.
 */
export async function scheduleSigtermGraceFlush(
  config: PodConfig,
  signalName: NodeJS.Signals,
): Promise<void> {
  try {
    const api = makeCustomObjectsApi();
    await writeStatus(
      config,
      {
        phase: 'Failed',
        error: `cancelled: ${signalName} grace-flush — runner did not unwind within ${String(GRACE_FLUSH_DEADLINE_MS)}ms`,
        completedAt: new Date().toISOString(),
        structuralVerdict: { suspicious: [] },
      },
      api,
    );
    console.warn(
      `[kagent-agent-pod] grace-flush: wrote Failed status patch after ${signalName} ` +
        `(runner did not unwind in ${String(GRACE_FLUSH_DEADLINE_MS)}ms)`,
    );
  } catch (err) {
    // Best-effort: lost the race already. Don't throw out of the
    // setTimeout callback (would crash the unrefed timer's host
    // process or get swallowed silently).
    console.error(
      `[kagent-agent-pod] grace-flush: writeStatus failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
  // Audit C2 H12 — propagate the resolved spec-source onto the live
  // process env so any downstream code (trace sinks, debug helpers,
  // child Job spec builders) can read `KAGENT_SPEC_SOURCE` without
  // re-deriving the source from filesystem state. Defensive: only set
  // if not already present so a parent-injected value (rare) wins.
  if (process.env.KAGENT_SPEC_SOURCE === undefined) {
    process.env.KAGENT_SPEC_SOURCE = config.specSource;
  }
  console.log(
    `[kagent-agent-pod] boot ${config.taskNamespace}/${config.taskName} ` +
      `agent=${config.agentName} model=${config.agentSpec.model} ` +
      `specSource=${config.specSource}`,
  );

  // Audit C2.1 BLOCKER #1 — capability mount is required-by-default.
  // `loadCapabilityOptional` throws when KAGENT_CAP_JWT_FILE is set
  // and the file is missing without `KAGENT_CAPABILITY_ALLOW_MISSING=true`.
  // Catch here so the pod fails fast with a `Failed` status patch
  // instead of CrashLoopBackOff with no operator-visible signal (the
  // audit's "JWT mount absence silently disables every cap-gated
  // guardrail" finding — fail-LOUD beats fail-OPEN).
  let loadedCapability: Awaited<ReturnType<typeof loadCapabilityOptional>>;
  try {
    loadedCapability = await loadCapabilityOptional({ env: process.env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[kagent-agent-pod] capability load failed:', message);
    try {
      const api = makeCustomObjectsApi();
      await writeStatus(
        config,
        {
          phase: 'Failed',
          error: `capability load failed: ${message}`,
          completedAt: new Date().toISOString(),
          structuralVerdict: { suspicious: [] },
        },
        api,
      );
    } catch (patchErr) {
      console.error(
        '[kagent-agent-pod] additionally failed to patch AgentTask Failed status:',
        patchErr instanceof Error ? patchErr.message : String(patchErr),
      );
    }
    process.exit(1);
  }
  const capabilityBundle = loadedCapability?.bundle;
  if (capabilityBundle !== undefined) {
    console.log(
      `[kagent-agent-pod] capability bundle loaded jti=${capabilityBundle.jti} exp=${String(capabilityBundle.exp)}`,
    );
  } else {
    console.warn('[kagent-agent-pod] capability bundle absent; running legacy claim path');
  }

  const auditNatsUrl = process.env.KAGENT_AUDIT_NATS_URL;
  const auditSource = 'kagent.knuteson.io/agent-pod';
  let auditPublisher: AuditPublisher | undefined;
  let auditReady: Promise<void> = Promise.resolve();
  const pendingAuditWrites: Promise<void>[] = [];
  if (typeof auditNatsUrl === 'string' && auditNatsUrl.length > 0) {
    auditPublisher = new AuditPublisher({ source: auditSource });
    // Best-effort: start connecting immediately, but keep task boot off
    // the audit path. Individual writes await this promise before
    // publishing so early spawn events don't race the initial NATS
    // connect; `AuditPublisher.connect()` swallows failures by design.
    auditReady = auditPublisher.connect(auditNatsUrl);
    console.log(`[kagent-agent-pod] audit publisher configured → ${auditNatsUrl}`);
  }
  const closeAuditPublisher = async (): Promise<void> => {
    if (auditPublisher !== undefined) {
      await Promise.allSettled(pendingAuditWrites);
      await auditPublisher.close();
    }
  };
  const emitCapUsed: Parameters<typeof defineSpawnChildTask>[0]['emitCapUsed'] | undefined =
    auditPublisher !== undefined
      ? (event) => {
          const write = auditReady.then(async () => {
            await auditPublisher?.publish(
              makeEvent({
                type: CAPABILITY_USED,
                source: auditSource,
                subject: `AgentTask/${config.taskNamespace}/${config.taskName}`,
                data: {
                  capabilityId: event.capabilityId,
                  taskUid: config.taskId,
                  claim: event.category,
                  target: event.target,
                },
              }),
            );
          });
          pendingAuditWrites.push(write);
        }
      : undefined;

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

    // Audit-rev2 M10 — SIGTERM grace flush. The normal shutdown path
    // is: abort → runner unwinds → main writes status. If the runner
    // hangs (e.g. blocked on a non-abort-aware sleep, hung downstream
    // call, or a fatal already-in-flight K8s patch retry), the kubelet
    // SIGKILLs us at terminationGracePeriodSeconds and the AgentTask
    // stays pinned in `Dispatched`. The grace-flush schedules a
    // best-effort writeStatus(Failed) at GRACE_FLUSH_DEADLINE_MS so
    // operator-visible terminal state is reached even when the runner
    // can't unwind. Best-effort: any throw from the patch is swallowed
    // (we already lost; just keep the pod alive long enough for
    // closeAuditPublisher / otelShutdown to flush).
    setTimeout(() => {
      void scheduleSigtermGraceFlush(config, signal);
    }, GRACE_FLUSH_DEADLINE_MS).unref();
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // v0.1.9 / NB1 (audit-rev2 C2 §2) — live-budget bridge.
  //
  // The executor allocates `RunBudget` AFTER `runAgentTask` is invoked,
  // but `defineGetMyContext` must be constructed BEFORE the run starts
  // (so the LLM can call the tool from iteration 0). We bridge that
  // ordering with a closure-shared mutable holder + an
  // `onBudgetReady` observer hook (threaded through runner.ts into
  // executor.ts). See `buildTokenUtilizationBridge` for the helper
  // that owns the holder + thunk; main.ts wires both ends, the helper
  // is exported for direct unit testing of the wireup.
  const { onBudgetReady, tokenUtilizationSnapshot } = buildTokenUtilizationBridge(
    config.contextWindowTokens,
  );

  // Audit-rev2 NM5 — `remainingBudgetSeconds` was previously scoped
  // inside the `if (spawnEnabled)` block (only the spawn / wait /
  // get_my_context tools needed it). With NM5 lifting
  // `defineGetMyContext` to a UNIVERSAL wireup inside `runAgentTask`,
  // the runner needs the same callback regardless of `spawnEnabled`
  // so the introspection tool reports `secondsRemaining` consistently.
  // Lifted to module-scope (relative to `main`) so both the spawn
  // block and `runAgentTask` see the same closure. Captures the
  // pod-boot timestamp so elapsed math is anchored to the actual
  // start, not the moment the spawn block runs (subtle but matters
  // for the get_my_context tool's first call).
  const remainingBudgetSeconds: (() => number | undefined) | undefined =
    config.taskSpec.runConfig?.timeoutSeconds !== undefined
      ? ((startMs: number, totalSec: number) => () => {
          const elapsedSec = (Date.now() - startMs) / 1000;
          return Math.max(0, totalSec - elapsedSec);
        })(Date.now(), config.taskSpec.runConfig.timeoutSeconds)
      : undefined;

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
      // v0.4.1-blackboard — Wave 3 / Blackboard sub-team. Forward this
      // task's resolved root UID (parsed from KAGENT_BLACKBOARD_BUCKET).
      // K8sTaskCreator stamps it onto every spawned child so the
      // operator's job-spec render path emits the same
      // KAGENT_BLACKBOARD_BUCKET on the child — every descendant
      // shares one bucket per root tree. Undefined falls back to
      // "treat parent UID as the new root" inside K8sTaskCreator
      // (back-compat with pre-Wave 3 deploys).
      ...(config.rootTaskUid !== undefined && { rootUid: config.rootTaskUid }),
    };
    // Audit-rev2 NM5 — `remainingBudgetSeconds` is now lifted to the
    // outer scope (above this `if (spawnEnabled)` block) so it can
    // also be threaded through `RunDeps.remainingBudgetSeconds` for
    // the universally-wired `get_my_context` tool inside
    // `resolveToolProviders`. Same callback, same closure timestamp.
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
      ...(capabilityBundle !== undefined && { parentCapability: capabilityBundle }),
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
      ...(getTraceparent !== undefined && { getTraceparent }),
      ...(maxDepth !== undefined && { maxDepth }),
      ...(emitCapUsed !== undefined && { emitCapUsed }),
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
    // Audit-rev2 NM5 — `get_my_context` is now wired UNIVERSALLY in
    // `runAgentTask` (`resolveToolProviders`'s `kagent-universal-context`
    // provider), regardless of `spawnEnabled`. Lifting it out of the
    // `if (spawnEnabled)` block means tests driving `runAgentTask`
    // directly with `Agent.spec.tools=['get_my_context']` no longer
    // get "unknown built-in tool" because spawn happened to be off.
    // The runner threads the SAME `tokenUtilizationSnapshot` and
    // `remainingBudgetSeconds` deps through `RunDeps`, so the
    // production observation contract (live snapshot at tool-call
    // time) is unchanged.
    const subTools = [spawnDefs, waitChildDef, waitAllDef];
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

  // === Wave 3 — Blackboard ===
  // v0.4.1-blackboard. The four blackboard tools register independently
  // of the spawn flag — they are useful even in chat-only / no-children
  // tasks (e.g. a single agent that wants persistent scratch state
  // across restart). The runner gates registration on:
  //   1. `KAGENT_BLACKBOARD_BUCKET` set (operator stamped it from the
  //      root task's UID). Absent = bucket not provisioned → tools
  //      cannot connect → drop them entirely so the LLM doesn't see
  //      tools it'll get errors on.
  //   2. `KAGENT_NATS_URL` set (same NATS broker the dispatcher /
  //      audit publisher use; we share the connection conceptually
  //      via lazy `connect()`).
  //
  // Cap-gating happens INSIDE each tool wrapper against the optional
  // capability bundle's `claims.blackboard.{read,write}` ACL. The
  // runner doesn't try to "filter by claim" at registration time —
  // that would conflate two layers and would silently swallow a
  // mis-configured Agent.spec.tools entry.
  let blackboardTools: ToolProvider | undefined;
  const bbBucket = process.env.KAGENT_BLACKBOARD_BUCKET;
  const bbNatsUrl = process.env.KAGENT_NATS_URL;
  if (
    typeof bbBucket === 'string' &&
    bbBucket.length > 0 &&
    typeof bbNatsUrl === 'string' &&
    bbNatsUrl.length > 0
  ) {
    try {
      const client = await buildBlackboardClientFromEnv({
        bucket: bbBucket,
        natsUrl: bbNatsUrl,
      });
      // Audit-rev2 M12 (= evidence/audit-rev2/C2.md §1 row M12): when
      // `KAGENT_BLACKBOARD_FAIL_OPEN=true` is set, every blackboard
      // operation gets `read: ['*'], write: ['*']` — cluster-wide
      // unrestricted access, regardless of the operator-minted cap
      // bundle's claims. This is intentional for development /
      // bootstrap clusters that haven't wired the cap-issuer yet, but
      // production deploys must NEVER fall through this path silently.
      // Emit a single boot-time WARN naming the override + the
      // consequence so an operator scanning logs sees the wide-open
      // posture immediately. The Helm-side gate (`acknowledgeUnsafe:
      // true` opt-in) is W3-Operator scope; this commit lands the
      // pod-side WARN as defense-in-depth.
      const failOpenBlackboard =
        process.env.KAGENT_BLACKBOARD_FAIL_OPEN === 'true'
          ? { read: ['*'], write: ['*'] }
          : undefined;
      if (failOpenBlackboard !== undefined) {
        console.warn(
          '[kagent-agent-pod] SECURITY: KAGENT_BLACKBOARD_FAIL_OPEN=true is set — ' +
            'blackboard claims defaulted to {read: [*], write: [*]} for this pod. ' +
            'Every blackboard tool call admits cluster-wide unrestricted access. ' +
            'This bypasses the cap-bundle ACL surface and MUST NOT be used in ' +
            "production. Set agentPod.blackboard.failOpen=false (the operator chart's " +
            'default) to remove this override; pair the dev override with ' +
            'agentPod.blackboard.acknowledgeUnsafe=true once the W3-Operator chart ' +
            'gate lands so Helm refuses install without explicit consent.',
        );
      }
      const blackboardClaim = capabilityBundle?.claims.blackboard ?? failOpenBlackboard;
      const defs = defineBlackboardTools({
        client,
        ...(blackboardClaim !== undefined && { claim: blackboardClaim }),
      });
      blackboardTools = new InProcessToolProvider({
        id: 'kagent-blackboard',
        tools: [...defs],
      });
      console.log(
        `[kagent-agent-pod] blackboard tools ENABLED bucket=${bbBucket} (read/write/list/append _blackboard)`,
      );
    } catch (err) {
      console.warn(
        `[kagent-agent-pod] blackboard tools DISABLED — boot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // === Wave 3 — Events ===
  // `publish_event` built-in tool. Wired only when the operator
  // threaded `KAGENT_EVENTS_NATS_URL` AND the Agent declares at
  // least one `publishes[]` entry.
  //
  // SECURITY (audit 2026-05-06 C2.2 HIGH #2): the cap-claim gate
  // threaded into `EventPublisher` + `definePublishEvent` is sourced
  // EXCLUSIVELY from the operator-minted, JWKS-verified
  // `CapabilityBundle` loaded by `cap-consumer.loadCapabilityFromEnv`.
  // We DO NOT fall back to synthesizing a bundle from the Agent CRD's
  // `spec.capabilityClaims.publish` field — that field is mutable by
  // anyone with `agents/edit` RBAC, so trusting it would let a
  // developer publish on any topic without ever obtaining an operator-
  // signed JWT. When no JWT is mounted, `definePublishEvent` correctly
  // refuses every emission with `policy_denied:no_capability`.
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
    const publishCapabilityBundle = selectPublishCapabilityBundle(
      capabilityBundle,
      claims?.publish,
    );
    if (publishCapabilityBundle === undefined) {
      console.warn(
        '[kagent-agent-pod] publish_event wired WITHOUT a verified capability bundle — every emission will refuse with policy_denied:no_capability (set KAGENT_CAP_JWT_FILE to enable publishing)',
      );
    }
    const publisher = new eventsModule.EventPublisher({
      source: `kagent.knuteson.io/agent-pod/${config.agentName}/${config.taskId}`,
      ...(publishCapabilityBundle?.claims.publish !== undefined && {
        publishClaims: publishCapabilityBundle.claims.publish,
      }),
    });
    await publisher.connect(eventsNatsUrl).catch((err: unknown) => {
      console.warn(
        `[kagent-agent-pod] publish_event NATS connect failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const publishDef = definePublishEvent({
      publisher,
      capabilityBundle: publishCapabilityBundle,
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
      ...(blackboardTools !== undefined && { blackboardTools }),
      ...(eventsTools !== undefined && { eventsTools }),
      ...(langfuseFetcher !== undefined && { fetchPrompt: langfuseFetcher }),
      ...(capabilityBundle !== undefined && { capabilityBundle }),
      // v0.1.9 / NB1 — capture the executor's live RunBudget into
      // `liveBudget` so the get_my_context tool's
      // `tokenUtilizationSnapshot` thunk reads cumulative tokens off
      // the SAME object the loop mutates each iteration.
      onBudgetReady,
      // Audit-rev2 NM5 — thread the production-ready snapshot +
      // budget-remaining thunks through to the runner's universal
      // `get_my_context` wireup. This is what makes the v0.1.9
      // marquee context-awareness feature work outside the
      // spawnEnabled block (e.g. chat-only researcher agents that
      // declare `get_my_context` in spec.tools without listing
      // spawn).
      tokenUtilizationSnapshot,
      ...(remainingBudgetSeconds !== undefined && { remainingBudgetSeconds }),
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
      await closeAuditPublisher();
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
  await closeAuditPublisher();

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
 * v0.1.9 / NB1 (audit-rev2 C2 §2) — live-budget bridge between the
 * executor's `RunBudget` (allocated inside `executor.run()`) and the
 * `tokenUtilizationSnapshot` dep that `defineGetMyContext` reads at
 * TOOL-CALL time.
 *
 * Returns a paired `{ onBudgetReady, tokenUtilizationSnapshot }` where:
 *
 *   - `onBudgetReady(budget)` is wired into `runAgentTask` via
 *     `RunDeps.onBudgetReady`. It captures the executor's mutable
 *     budget reference into a closure-shared variable.
 *   - `tokenUtilizationSnapshot()` is wired into `defineGetMyContext`
 *     via `GetMyContextDeps.tokenUtilizationSnapshot`. It reads
 *     cumulative input + output tokens off the SAME object the
 *     executor mutates after every successful chat() call, plus the
 *     operator-projected `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` (passed
 *     in via `contextWindowTokens`).
 *
 * Before this bridge existed, the `tokenUtilizationSnapshot` dep was
 * omitted from production wiring while tests injected it directly,
 * so `get_my_context` always returned the `{ used: 0, modelWindow:
 * null }` fallback in production — making v0.1.9's marquee
 * context-awareness feature inert. See
 * `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md` for the
 * detection discipline this regression was found through.
 *
 * Pure factory — exported so the regression test can drive the exact
 * production wireup pattern without spawning the agent-pod process.
 */
export function buildTokenUtilizationBridge(contextWindowTokens: number | undefined): {
  readonly onBudgetReady: (budget: RunBudget) => void;
  readonly tokenUtilizationSnapshot: () => {
    readonly used: number;
    readonly modelWindow: number | null;
  };
} {
  let liveBudget: RunBudget | undefined;
  const onBudgetReady = (budget: RunBudget): void => {
    liveBudget = budget;
  };
  const tokenUtilizationSnapshot = (): {
    readonly used: number;
    readonly modelWindow: number | null;
  } => {
    const used =
      liveBudget !== undefined
        ? liveBudget.cumulativeInputTokens + liveBudget.cumulativeOutputTokens
        : 0;
    return {
      used,
      modelWindow: contextWindowTokens ?? null,
    };
  };
  return { onBudgetReady, tokenUtilizationSnapshot };
}

/**
 * Audit C2.2 HIGH #2 — single decision point for which (if any)
 * `CapabilityBundle` is threaded into the publish-event wiring.
 *
 * Trust rule: ONLY the operator-minted, JWKS-verified bundle counts.
 * The Agent CRD's `spec.capabilityClaims.publish` is mutable by anyone
 * with `agents/edit` RBAC; trusting it would let a developer publish on
 * any topic without ever obtaining an operator-signed JWT. We therefore
 * NEVER synthesize a bundle from the agent-spec field. The
 * `_agentSpecPublishClaims` parameter is kept in the signature solely
 * so callers + reviewers see the rejected input — it is intentionally
 * unused.
 *
 * Pure function — exported for the unit test suite.
 */
export function selectPublishCapabilityBundle(
  operatorBundle: CapabilityBundle | undefined,
  _agentSpecPublishClaims: readonly string[] | undefined,
): CapabilityBundle | undefined {
  return operatorBundle;
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
