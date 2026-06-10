/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure mapping helpers — `taskSummary`, `taskDetail`, `agentSummary`,
 * `podFailureSummary`, `traceLink`. Every helper:
 *
 *   1. Takes plain object inputs (no K8s clients, no fetch).
 *   2. Tolerates partial fixtures (missing status, missing pod, missing
 *      Agent reference) — degrades to undefined fields rather than
 *      throwing. The brief is explicit: a list view must still render
 *      even when the operator hasn't observed the task yet.
 *   3. Returns frozen-shape DTOs (typescript readonly enforced; no
 *      runtime Object.freeze — keeps the helpers cheap).
 *
 * Naming: these are the only public mappers; never expose intermediate
 * "build the X part of Y" helpers as exports — keeps the public surface
 * tractable for SemVer.
 */

import { createHash } from 'node:crypto';

import type { V1ContainerStatus, V1Job, V1Pod } from '@kubernetes/client-node';

import type { Agent, AgentTask } from './crds.js';
import { detectFailure } from './failure.js';
import type {
  AgentSummary,
  AgentTaskCounts,
  ArtifactSummary,
  EventSummary,
  PodFailureSummary,
  TaskDetail,
  TaskSummary,
  TraceLink,
} from './types.js';

/* =====================================================================
 * Task mappers
 * ===================================================================== */

export interface TaskSummaryOptions {
  readonly job?: V1Job;
  readonly pod?: V1Pod;
  readonly agent?: Agent;
  readonly traceLink?: TraceLink;
}

/**
 * Map an AgentTask (+ optional Job/Pod/Agent context) into a list-row
 * summary. The mapper NEVER reads from the cluster — all fields come
 * from the supplied inputs.
 *
 * `opts.job` and `opts.pod` are intentionally NOT used to surface
 * suspicious-tags; those come from `task.status.structuralVerdict`
 * which the agent-pod writes. Job/Pod ARE used (transitively, by
 * callers wanting podFailureSummary) to surface terminal failure
 * messages — see `podFailureSummary` below.
 */
export function taskSummary(task: AgentTask, opts: TaskSummaryOptions = {}): TaskSummary {
  const status = task.status;
  const meta = task.metadata;

  return {
    name: meta.name ?? '',
    namespace: meta.namespace ?? 'default',
    uid: meta.uid ?? '',
    ...(status?.phase !== undefined && { phase: status.phase }),
    ...(task.spec.targetAgent !== undefined && { targetAgent: task.spec.targetAgent }),
    ...(task.spec.targetCapability !== undefined && {
      targetCapability: task.spec.targetCapability,
    }),
    ...(opts.agent?.spec.model !== undefined && { model: opts.agent.spec.model }),
    ...(meta.creationTimestamp !== undefined && {
      createdAt: toIso(meta.creationTimestamp),
    }),
    ...(status?.startedAt !== undefined && { startedAt: status.startedAt }),
    ...(status?.completedAt !== undefined && { completedAt: status.completedAt }),
    ...(status?.podName !== undefined && { podName: status.podName }),
    ...(status?.error !== undefined && { error: status.error }),
    ...(status?.structuralVerdict?.suspicious !== undefined && {
      suspicious: status.structuralVerdict.suspicious,
    }),
    ...(status?.artifacts !== undefined && {
      artifactCount: status.artifacts.length,
    }),
    ...(status?.children !== undefined && {
      childCount: status.children.length,
    }),
    ...(status?.aggregatePhase !== undefined && {
      aggregatePhase: status.aggregatePhase,
    }),
    ...(opts.traceLink !== undefined && {
      traceLink: opts.traceLink,
    }),
  };
}

export interface TaskDetailOptions extends TaskSummaryOptions {
  /**
   * Pre-projected K8s events. v0.1 callers don't pass anything; v0.2
   * Workbench facade will batch-fetch + project before calling.
   */
  readonly events?: readonly EventSummary[];
}

/**
 * Map an AgentTask into a detail-page projection. Extends taskSummary
 * with the heavy fields the list view doesn't carry.
 */
export function taskDetail(task: AgentTask, opts: TaskDetailOptions = {}): TaskDetail {
  const summary = taskSummary(task, opts);
  const containerStatuses: readonly V1ContainerStatus[] = opts.pod?.status?.containerStatuses ?? [];

  return {
    ...summary,
    ...(task.spec.originalUserMessage !== undefined && {
      originalUserMessage: task.spec.originalUserMessage,
    }),
    ...(task.spec.payload !== undefined && { payload: task.spec.payload }),
    ...(task.status?.result !== undefined && { result: task.status.result }),
    ...(task.spec.expectedTools !== undefined && { expectedTools: task.spec.expectedTools }),
    ...(task.spec.parentDistillation !== undefined && {
      parentDistillation: task.spec.parentDistillation,
    }),
    ...(task.spec.parentTask !== undefined && { parentTask: task.spec.parentTask }),
    containerStatuses,
    eventsSummary: opts.events ?? [],
    ...(task.status?.artifacts !== undefined && {
      artifacts: task.status.artifacts.map((a): ArtifactSummary => {
        const summary: {
          uri: string;
          mediaType?: string;
          sizeBytes?: number;
          name?: string;
          producedAt?: string;
          producedByTask?: string;
        } = { uri: a.uri };
        if (a.mediaType !== undefined) summary.mediaType = a.mediaType;
        if (a.sizeBytes !== undefined) summary.sizeBytes = a.sizeBytes;
        if (a.name !== undefined) summary.name = a.name;
        if (a.producedAt !== undefined) summary.producedAt = a.producedAt;
        if (task.metadata.uid !== undefined) summary.producedByTask = task.metadata.uid;
        return summary;
      }),
    }),
    ...(task.status?.children !== undefined && { children: task.status.children }),
    ...(task.status?.successCount !== undefined && { successCount: task.status.successCount }),
    ...(task.status?.failureCount !== undefined && { failureCount: task.status.failureCount }),
    ...(task.status?.inFlightCount !== undefined && { inFlightCount: task.status.inFlightCount }),
  };
}

/* =====================================================================
 * Agent mapper
 * ===================================================================== */

export interface AgentSummaryOptions {
  /**
   * Optional snapshot of AgentTasks the caller wants counted into the
   * summary. Filters by `spec.targetAgent === agent.metadata.name` AND
   * matching namespace. No filter = no counts (avoids cross-namespace
   * counting surprises).
   */
  readonly tasks?: readonly AgentTask[];
}

const ZERO_COUNTS: AgentTaskCounts = {
  pending: 0,
  dispatched: 0,
  completed: 0,
  failed: 0,
};

export function agentSummary(agent: Agent, opts: AgentSummaryOptions = {}): AgentSummary {
  const namespace = agent.metadata.namespace ?? 'default';
  const counts = opts.tasks
    ? countTasks(agent.metadata.name ?? '', namespace, opts.tasks)
    : ZERO_COUNTS;

  return {
    name: agent.metadata.name ?? '',
    namespace,
    ...(agent.spec.model !== undefined && { model: agent.spec.model }),
    ...(agent.spec.modelClass !== undefined && { modelClass: agent.spec.modelClass }),
    sandboxProfile: agent.spec.sandboxProfile ?? 'default',
    capabilities: agent.spec.capabilities ?? [],
    tools: agent.spec.tools ?? [],
    ...(agent.spec.toolProfileRef !== undefined && { toolProfileRef: agent.spec.toolProfileRef }),
    ...(agent.spec.agentType !== undefined && { agentType: agent.spec.agentType }),
    recentTaskCounts: counts,
  };
}

function countTasks(
  agentName: string,
  namespace: string,
  tasks: readonly AgentTask[],
): AgentTaskCounts {
  let pending = 0;
  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  for (const t of tasks) {
    if (t.spec.targetAgent !== agentName) continue;
    if ((t.metadata.namespace ?? 'default') !== namespace) continue;
    switch (t.status?.phase) {
      case 'Pending':
        pending++;
        break;
      case 'Dispatched':
        dispatched++;
        break;
      case 'Completed':
        completed++;
        break;
      case 'Failed':
        failed++;
        break;
      default:
        // Unset phase counts as Pending — the operator hasn't observed it yet.
        pending++;
        break;
    }
  }
  return { pending, dispatched, completed, failed };
}

/* =====================================================================
 * Failure mapper
 * ===================================================================== */

/**
 * Wraps `detectFailure` so the DTO layer doesn't re-derive K8s failure
 * classification logic. Returns null when the Job (and optional Pod)
 * are healthy / still progressing.
 *
 * Surface choice: returns the rich `PodFailureSummary` (verdict +
 * pod/container deep-link bits) rather than the bare verdict, so a
 * Workbench panel can render "ImagePullBackOff in pod kat-9b-xyz
 * container agent" without the consumer touching the V1Pod shape.
 */
export function podFailureSummary(job: V1Job, pod?: V1Pod): PodFailureSummary | null {
  const verdict = detectFailure(job, pod);
  if (verdict === null) return null;

  const summary: {
    verdict: typeof verdict;
    podName?: string;
    containerName?: string;
    lastTransitionTime?: string;
  } = { verdict };

  if (pod?.metadata?.name !== undefined) {
    summary.podName = pod.metadata.name;
  }

  // For container-waiting verdicts, find the container that triggered
  // it so the UI can link to its logs.
  if (verdict.source === 'pod' && pod !== undefined) {
    const triggeringContainer = pod.status?.containerStatuses?.find((cs) => {
      const waiting = cs.state?.waiting;
      return waiting?.reason === verdict.reason;
    });
    if (triggeringContainer !== undefined) {
      summary.containerName = triggeringContainer.name;
    }

    // Best-effort transition timestamp: pod condition or container
    // state.waiting.message rarely carries timestamps directly, so fall
    // back to the pod's most-recent condition lastTransitionTime.
    const podConditions = pod.status?.conditions ?? [];
    const mostRecent = podConditions
      .map((c) => c.lastTransitionTime)
      .filter((t): t is Date => t !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (mostRecent !== undefined) {
      summary.lastTransitionTime = toIso(mostRecent);
    }
  } else if (verdict.source === 'job') {
    const jobConditions = job.status?.conditions ?? [];
    const mostRecent = jobConditions
      .map((c) => c.lastTransitionTime)
      .filter((t): t is Date => t !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (mostRecent !== undefined) {
      summary.lastTransitionTime = toIso(mostRecent);
    }
  }

  return summary;
}

/* =====================================================================
 * Trace link mapper
 * ===================================================================== */

export interface TraceLinkOptions {
  readonly provider: TraceLink['provider'];
  /**
   * Provider base URL (e.g. `https://langfuse.knuteson.io`). When set,
   * the mapper returns a fully-resolved deep-link in `url`. When omitted,
   * the URL is left undefined and the consumer can render runId-only.
   */
  readonly baseUrl?: string;
}

/**
 * Build a TraceLink from a task UID. Returns null when the task lacks a
 * UID (defensive — list-row renderers shouldn't show a "View trace"
 * button that 404s).
 *
 * Substrate convention (per Phase 4 OTel sink): the AgentTask UID is
 * re-used as the trace's runId. If a future provider needs a different
 * mapping, feature-detect on `provider` and branch here.
 */
export function traceLink(task: AgentTask, opts: TraceLinkOptions): TraceLink | null {
  const uid = task.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  const traceId = traceIdFromTraceparent(task.spec.runConfig?.traceparent) ?? deriveTraceId(uid);

  const link: { provider: TraceLink['provider']; runId: string; url?: string } = {
    provider: opts.provider,
    runId: uid,
  };

  if (opts.baseUrl !== undefined) {
    link.url = renderTraceUrl(opts.provider, opts.baseUrl, traceId);
  }

  return link;
}

/**
 * Derive the OTel trace ID the substrate's `OtelTraceSink` actually
 * emits for a given runId. MUST stay byte-identical to
 * `traceIdFromRunId` in `@kagent/trace-sinks/src/otel-sink.ts` —
 * inlined here (rather than imported) to keep `@kagent/dto` a
 * leaf data package with no OTel runtime dependency.
 *
 * Why the mirror exists: the AgentTask UID is the human-readable runId
 * (good for log-grep + audit), but the actual trace ID stored in
 * Langfuse / Jaeger is `sha256(runId)[0..32]`. A "View trace" deep-link
 * built from the UID 404s in Langfuse — the trace doesn't exist at that
 * key. WS-D shipped this derivation in trace-sinks; this is the
 * consumer-side mirror so dto-built URLs resolve.
 */
function deriveTraceId(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

function traceIdFromTraceparent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value);
  if (m === null) return undefined;
  const traceId = m[1] ?? '';
  const spanId = m[2] ?? '';
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return traceId;
}

function renderTraceUrl(provider: TraceLink['provider'], baseUrl: string, traceId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  switch (provider) {
    case 'langfuse':
      // Langfuse trace URLs follow `<host>/trace/<traceId>` per the
      // self-hosted UI route. The trace ID is either inherited from a
      // child task's traceparent or derived from the task UID.
      return `${trimmed}/trace/${traceId}`;
    case 'jaeger':
      // Jaeger UI: `<host>/trace/<traceId>`. Same OTel 32-hex trace ID
      // semantics as Langfuse.
      return `${trimmed}/trace/${traceId}`;
    case 'otel-collector':
      // OTel collector has no UI; return the OTLP endpoint as-is so a
      // CLI consumer can curl it. Workbench callers usually pass
      // 'langfuse' once Langfuse is up.
      return trimmed;
    default: {
      // Exhaustive switch — TS will error here if a new provider lands
      // and we forget to handle it.
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

/* =====================================================================
 * Re-exports for ergonomics — these aren't mappers but consumers usually
 * want the placeholder type alongside the live ones.
 * ===================================================================== */

export type { ArtifactSummary };

/* =====================================================================
 * Internal helpers
 * ===================================================================== */

function toIso(value: Date | string): string {
  if (typeof value === 'string') return value;
  return value.toISOString();
}
