/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * GET /api/review-queue — Phase 4 / REV-01 read projection.
 *
 * Computes per-AgentTask review-queue rows from the SnapshotCache.
 * Pure-read GET handler; no `customApi` calls in the GET path.
 * POST handlers (`/accept`, `/reject`, `/request`) are stubs here;
 * Plan 04-03 (W2) implements them.
 *
 * Classifier priority (CONTEXT.md D-01-A, highest wins):
 *   verifier-failed > suspicious-detector > human-review-requested > candidate-template
 *
 * Tasks with `kagent.knuteson.io/review-decision` annotation already
 * set are SKIPPED — they have been reviewed and are not re-queued.
 *
 * REV-03: replay-divergence and eval-failed are reserved for
 * AgentTaskRun + @kagent/eval (Phase 5+). v0.2 producers: zero.
 * The classifier has NO code path that emits these reasons.
 * See docs/REPLAY-EVALS.md (Phase 5 design).
 *
 * @see REQUIREMENTS.md REV-01, REV-03
 * @see CONTEXT.md D-01-A
 * @see PATTERNS.md W1.1
 */

import { Hono } from 'hono';
import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';
import { assertIsReviewQueueRow, type ArtifactRefSummary, type ReviewQueueRow } from '@kagent/dto';
import type { AgentTask, AgentTaskPhase } from '@kagent/dto';
import {
  REVIEW_REQUESTED,
  REVIEW_ACCEPTED,
  REVIEW_REJECTED,
  TEMPLATE_CANDIDATE_PROMOTED,
  makeEvent,
  type AuditEvent,
} from '@kagent/audit-events';

import type { SnapshotCache } from '../cache.js';

// Re-export type references for Plan 03 W2 POST handlers (so import
// blocks stay stable across plans). These consts are used by Plan 03.
void REVIEW_REQUESTED;
void REVIEW_ACCEPTED;
void REVIEW_REJECTED;
void TEMPLATE_CANDIDATE_PROMOTED;
void makeEvent;
void assertIsReviewQueueRow;

/**
 * MERGE_PATCH_OPTIONS: content-type header for K8s annotation patch
 * operations. Used by Plan 04-03's POST handlers (accept/reject/request
 * write annotation to the AgentTask). Landing here keeps the import
 * block stable across plans.
 */
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');
// Suppress "unused variable" — Plan 03 POST handlers use this.
void MERGE_PATCH_OPTIONS;

/** Known annotation key: blocks task from re-entering the review queue. */
const ANNOTATION_REVIEW_DECISION = 'kagent.knuteson.io/review-decision';
/** Known annotation key: triggers human-review-requested path. */
const ANNOTATION_REVIEW_REQUESTED = 'kagent.knuteson.io/review-requested';
/** Known annotation key: who requested the review. */
const ANNOTATION_REVIEW_REQUESTED_BY = 'kagent.knuteson.io/review-requested-by';
/** Known annotation key: when the review was requested (ISO 8601). */
const ANNOTATION_REVIEW_REQUESTED_AT = 'kagent.knuteson.io/review-requested-at';
/** Known annotation key: marks a task as a candidate for AgentTemplate promotion. */
const ANNOTATION_TEMPLATE_CANDIDATE = 'kagent.knuteson.io/template-candidate';
/** Known annotation key: optional custom proposed template name. */
const ANNOTATION_PROPOSED_TEMPLATE_NAME = 'kagent.knuteson.io/proposed-template-name';

/** MediaType that identifies a candidate AgentTemplate artifact. */
const TEMPLATE_CANDIDATE_MEDIA_TYPE = 'application/x-kagent-template-candidate+yaml';

export interface ReviewQueueRouteDeps {
  /** Required: source of task snapshots. */
  readonly cache: SnapshotCache;
  /** Optional: K8s write client for Plan 03 POST handlers. */
  readonly customApi?: CustomObjectsApi;
  /**
   * Optional audit publisher for Plan 03 POST write events
   * (review.accepted, review.rejected, review.requested,
   * template.candidate.promoted). The GET handler emits no audit events.
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /** Test-injectable clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Default namespace for promotion writes (Plan 03). */
  readonly defaultNamespace?: string;
  /** Langfuse base URL for trace deep-links in the review row. */
  readonly langfuseBaseUrl?: string;
  /** Logger surface. Defaults to console.warn / console.error. */
  readonly logger?: { warn(message: string): void; error?(message: string): void };
}

/**
 * Factory for the `/api/review-queue` Hono app.
 *
 * LM-1 mount pattern: register handlers on "/" and "/:namespace/:name/..."
 * INSIDE the factory; mount at "/api/review-queue" from router.ts.
 * DO NOT register on "/api/review-queue" inside this factory.
 */
export function reviewQueueRoute(deps: ReviewQueueRouteDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? ((): Date => new Date());
  const logWarn =
    deps.logger !== undefined
      ? (m: string): void => {
          deps.logger!.warn(m);
        }
      : (m: string): void => {
          console.warn(m);
        };
  // logError is used by Plan 04-03 W2 POST handlers when K8s patching fails.
  const logError =
    deps.logger?.error !== undefined
      ? (m: string): void => {
          deps.logger!.error!(m);
        }
      : (m: string): void => {
          console.error(m);
        };
  void logError; // referenced by Plan 04-03 POST handlers; keep for stable import block

  // ------------------------------------------------------------------
  // GET / — project the review queue from the SnapshotCache.
  // Pure-read: no K8s API calls, no mutations.
  // O(|cache.tasks|) per request (homelab scale; REV-01).
  // ------------------------------------------------------------------
  app.get('/', (c) => {
    const tasks = deps.cache.listTasks();
    const items: ReviewQueueRow[] = [];
    const nowMs = now().getTime();

    for (const task of tasks) {
      const annotations: Record<string, string> =
        (task.metadata?.annotations as Record<string, string> | undefined) ?? {};

      // Step 1 (D-01-A): skip already-decided tasks.
      if (annotations[ANNOTATION_REVIEW_DECISION] !== undefined) continue;

      // Steps 2–5: run the priority-ordered classifier.
      const row = classifyTask(task, nowMs, deps.langfuseBaseUrl, deps.defaultNamespace);
      if (row !== undefined) {
        items.push(row);
      }
    }

    // Sort descending by stalenessSeconds: oldest enqueuedAt first (REV-01).
    items.sort((a, b) => b.stalenessSeconds - a.stalenessSeconds);

    return c.json({ items });
  });

  // ------------------------------------------------------------------
  // POST handler stubs — Plan 04-03 (W2) implements these.
  //
  // The factory registers the URL space here so router.ts wiring is
  // stable across plans. Hono first-match-wins routing: the GET handler
  // above is registered first and takes precedence for GET requests;
  // these POST stubs only catch POST requests to the sub-paths.
  // ------------------------------------------------------------------
  app.post('/:namespace/:name/accept', (c) => {
    logWarn(`review-queue: accept not yet implemented (Plan 04-03): ${c.req.url}`);
    return c.json({ error: 'accept handler not yet implemented (Plan 04-03)' }, 501);
  });
  app.post('/:namespace/:name/reject', (c) => {
    logWarn(`review-queue: reject not yet implemented (Plan 04-03): ${c.req.url}`);
    return c.json({ error: 'reject handler not yet implemented (Plan 04-03)' }, 501);
  });
  app.post('/:namespace/:name/request', (c) => {
    logWarn(`review-queue: request not yet implemented (Plan 04-03): ${c.req.url}`);
    return c.json({ error: 'request handler not yet implemented (Plan 04-03)' }, 501);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Pure classifier — CONTEXT.md D-01-A steps 2–5.
// No I/O, no Date.now() reads except via nowMs, no mutations.
// Returns undefined → task is omitted from the queue.
// ---------------------------------------------------------------------------

/**
 * Classify a single AgentTask into a ReviewQueueRow (or undefined to
 * omit it). Implements CONTEXT.md D-01-A priority steps 2–5:
 *
 *   2. verifier-failed   (passed === false)
 *   3. suspicious-detector  (suspicious.length > 0)
 *   4. human-review-requested  (annotation review-requested=true)
 *   5. candidate-template  (Completed + annotation + matching artifact)
 *
 * REV-03: replay-divergence and eval-failed are NOT reachable from
 * this function — zero v0.2 producers (D-04-A inline note).
 */
export function classifyTask(
  task: AgentTask,
  nowMs: number,
  langfuseBaseUrl: string | undefined,
  defaultNamespace?: string,
): ReviewQueueRow | undefined {
  const status = (task.status as Record<string, unknown> | undefined) ?? {};
  const metadata = task.metadata ?? {};
  const annotations: Record<string, string> =
    (metadata.annotations as Record<string, string> | undefined) ?? {};
  const namespace = typeof metadata.namespace === 'string' ? metadata.namespace : 'default';
  const name = typeof metadata.name === 'string' ? metadata.name : '';
  const uid = typeof metadata.uid === 'string' ? metadata.uid : '';
  const creationTimestamp =
    typeof metadata.creationTimestamp === 'string' ? metadata.creationTimestamp : undefined;
  const phase = (status['phase'] as AgentTaskPhase | undefined) ?? 'Pending';
  const statusCompletedAt =
    typeof status['completedAt'] === 'string' ? status['completedAt'] : undefined;
  const nowIso = new Date(nowMs).toISOString();
  const fallbackEnqueuedAt = statusCompletedAt ?? creationTimestamp ?? nowIso;

  // -- Common row fields shared across all priority branches --
  const taskRef = { namespace, name, uid } as const;
  const targetAgent =
    typeof task.spec?.targetAgent === 'string' ? task.spec.targetAgent : undefined;
  const model = undefined; // AgentTaskSpec has no model field (tasks use targetAgent → Agent.spec.model)
  const traceLink =
    typeof langfuseBaseUrl === 'string' && uid.length > 0
      ? `${langfuseBaseUrl}/traces/${uid}`
      : undefined;
  const artifactCount = Array.isArray(status['artifacts'])
    ? (status['artifacts'] as unknown[]).length
    : 0;

  // -- Step 2: verifier-failed (priority 1) --
  // D-01-A: if verification.passed === false, this task is in the queue.
  const verification = status['verification'] as
    | { passed?: boolean; reason?: string; completedAt?: string; mode?: string }
    | undefined;
  if (verification?.passed === false) {
    const enqueuedAt = verification.completedAt ?? statusCompletedAt ?? creationTimestamp ?? nowIso;
    const reasonDetail = verification.reason ?? 'verifier failed';
    const verifierError = verification.reason;
    const stalenessSeconds = computeStaleness(nowMs, enqueuedAt);
    const row: ReviewQueueRow = {
      taskRef,
      reason: 'verifier-failed',
      reasonDetail,
      enqueuedAt,
      stalenessSeconds,
      phase,
      ...(targetAgent !== undefined && { targetAgent }),
      ...(model !== undefined && { model }),
      ...(verifierError !== undefined && { verifierError }),
      ...(traceLink !== undefined && { traceLink }),
      ...(artifactCount > 0 && { artifactCount }),
    };
    return row;
  }

  // -- Step 3: suspicious-detector (priority 2) --
  // D-01-A: if structuralVerdict.suspicious is non-empty.
  const structuralVerdict = status['structuralVerdict'] as
    | { suspicious?: readonly string[] }
    | undefined;
  const suspicious = structuralVerdict?.suspicious ?? [];
  if (suspicious.length > 0) {
    const enqueuedAt = fallbackEnqueuedAt;
    const reasonDetail = suspicious.join(', ');
    const stalenessSeconds = computeStaleness(nowMs, enqueuedAt);
    const row: ReviewQueueRow = {
      taskRef,
      reason: 'suspicious-detector',
      reasonDetail,
      enqueuedAt,
      stalenessSeconds,
      phase,
      suspicious: [...suspicious],
      ...(targetAgent !== undefined && { targetAgent }),
      ...(model !== undefined && { model }),
      ...(traceLink !== undefined && { traceLink }),
      ...(artifactCount > 0 && { artifactCount }),
    };
    return row;
  }

  // -- Step 4: human-review-requested (priority 3) --
  // D-01-A: annotation 'kagent.knuteson.io/review-requested' === 'true'.
  if (annotations[ANNOTATION_REVIEW_REQUESTED] === 'true') {
    const requestedBy = annotations[ANNOTATION_REVIEW_REQUESTED_BY] ?? 'unknown';
    const requestedAt = annotations[ANNOTATION_REVIEW_REQUESTED_AT];
    const enqueuedAt = requestedAt ?? creationTimestamp ?? nowIso;
    const reasonDetail = `requested by ${requestedBy}`;
    const stalenessSeconds = computeStaleness(nowMs, enqueuedAt);
    const row: ReviewQueueRow = {
      taskRef,
      reason: 'human-review-requested',
      reasonDetail,
      enqueuedAt,
      stalenessSeconds,
      phase,
      ...(targetAgent !== undefined && { targetAgent }),
      ...(model !== undefined && { model }),
      ...(traceLink !== undefined && { traceLink }),
      ...(artifactCount > 0 && { artifactCount }),
    };
    return row;
  }

  // -- Step 5: candidate-template (priority 4) --
  // D-01-A: REQUIRES phase === 'Completed' AND annotation === 'true'
  //         AND a matching artifact exists.
  // If the artifact is missing: OMIT the task (return undefined per RESEARCH.md Q1 step 5).
  if (annotations[ANNOTATION_TEMPLATE_CANDIDATE] === 'true' && phase === 'Completed') {
    const candidateArtifact = findCandidateArtifact(task);
    if (candidateArtifact === undefined) {
      // No matching artifact → omit (return undefined, not a queue entry).
      return undefined;
    }

    const enqueuedAt = fallbackEnqueuedAt;
    const proposedTemplateName =
      annotations[ANNOTATION_PROPOSED_TEMPLATE_NAME] ?? `${name}-template`;
    const proposedNamespace = namespace ?? defaultNamespace ?? 'default';
    const reasonDetail = `candidate AgentTemplate from ${proposedNamespace}/${name}`;
    const stalenessSeconds = computeStaleness(nowMs, enqueuedAt);

    const row: ReviewQueueRow = {
      taskRef,
      reason: 'candidate-template',
      reasonDetail,
      enqueuedAt,
      stalenessSeconds,
      phase,
      candidateTemplate: {
        artifactRef: candidateArtifact.artifactRef,
        proposedTemplateName,
        proposedNamespace,
      },
      ...(targetAgent !== undefined && { targetAgent }),
      ...(model !== undefined && { model }),
      ...(traceLink !== undefined && { traceLink }),
      ...(artifactCount > 0 && { artifactCount }),
    };
    return row;
  }

  // No matching classifier branch → task is NOT in the queue.
  // REV-03: replay-divergence and eval-failed are NOT reachable here.
  // D-04-A: these reasons have zero v0.2 producers (Phase 5+ stubs).
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: find the first artifact with the candidate-template mediaType.
// D-03-A "Claude's Discretion" default: first matching artifact.
// ---------------------------------------------------------------------------

interface CandidateArtifactResult {
  readonly artifactRef: ArtifactRefSummary;
}

/**
 * Find the first artifact whose mediaType matches
 * `application/x-kagent-template-candidate+yaml`.
 * Returns undefined if no matching artifact exists.
 */
function findCandidateArtifact(task: AgentTask): CandidateArtifactResult | undefined {
  const artifacts = task.status?.artifacts;
  if (!Array.isArray(artifacts)) return undefined;

  for (const artifact of artifacts) {
    if (typeof artifact !== 'object' || artifact === null) continue;
    const a = artifact as {
      uri?: unknown;
      mediaType?: unknown;
      name?: unknown;
      sizeBytes?: unknown;
      checksum?: unknown;
      producedAt?: unknown;
    };
    if (a.mediaType !== TEMPLATE_CANDIDATE_MEDIA_TYPE) continue;
    if (typeof a.uri !== 'string') continue;

    const artifactRef: ArtifactRefSummary = {
      uri: a.uri,
      ...(typeof a.mediaType === 'string' && { mediaType: a.mediaType }),
      ...(typeof a.name === 'string' && { name: a.name }),
      ...(typeof a.sizeBytes === 'number' && { sizeBytes: a.sizeBytes }),
      ...(typeof a.checksum === 'string' && { checksum: a.checksum }),
      ...(typeof a.producedAt === 'string' && { producedAt: a.producedAt }),
    };
    return { artifactRef };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: compute stalenessSeconds from nowMs and enqueuedAt.
// D-01-A formula: Math.max(0, Math.floor((nowMs - Date.parse(enqueuedAt)) / 1000))
// ---------------------------------------------------------------------------

function computeStaleness(nowMs: number, enqueuedAt: string): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(enqueuedAt)) / 1000));
}
