/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ReviewQueueRow — Phase 4 / REV-01 read projection.
 *
 * The workbench-api computes this row per AgentTask that meets at
 * least one review signal (verifier failure, suspicious-detector flag,
 * explicit operator annotation, or candidate-template artifact). Spec
 * fields mirror the AgentTask's `pilotEvidence`, `status`, and
 * `metadata.annotations`. NO new persistence primitive — D2.
 *
 * The DTO is the single source of truth across the substrate-API-UI
 * tier boundary: workbench-api emits it, workbench-ui consumes it
 * (REV-01 / D-01-A). Adding a field is SemVer-minor; renaming or
 * removing one is SemVer-major.
 *
 * Classifier priority (highest wins; a task emits at most one row):
 *   verifier-failed > suspicious-detector > human-review-requested > candidate-template
 *
 * Tasks with `kagent.knuteson.io/review-decision` annotation already
 * set are SKIPPED — they have been reviewed and are removed from the
 * queue by that annotation presence.
 */

import type { ArtifactRef, AgentTaskPhase } from './crds.js';

/**
 * Summary-level view of an ArtifactRef carried by a candidate
 * AgentTemplate task. Intentionally shallow — callers that need full
 * artifact detail can join against the task's own artifacts list.
 * Fields mirror `ArtifactRef` (in dto/crds.ts) but are all optional
 * so partial artifact records don't break the guard.
 */
export interface ArtifactRefSummary {
  readonly uri: string;
  readonly mediaType?: string | undefined;
  readonly name?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly checksum?: string | undefined;
  readonly producedAt?: string | undefined;
}

// REV-03: replay-divergence and eval-failed reasons are reserved for
// AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
// pre-implementation as of 2026-05-10). v0.2 producers: zero. Promote
// when AgentTaskRun ships and the eval reducer emits divergence audit
// events. Until then verifier-failed + suspicious-detector cover what
// REQUIREMENTS.md REV-03 calls 'replay/eval signals' today.
export type ReviewReason =
  | 'verifier-failed'
  | 'suspicious-detector'
  | 'human-review-requested'
  | 'candidate-template'
  | 'replay-divergence' // Phase 5+ stub; zero v0.2 producers
  | 'eval-failed'; // Phase 5+ stub; zero v0.2 producers

/**
 * One row per AgentTask in the review queue.
 * Returned by `GET /api/review-queue` as `ReviewQueueRow[]`, sorted
 * by descending `stalenessSeconds` (oldest first per REV-01).
 */
export interface ReviewQueueRow {
  /** Kubernetes identity of the AgentTask under review. */
  readonly taskRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };

  /**
   * Classifier-determined review reason. Closed enum; priority:
   * verifier-failed > suspicious-detector > human-review-requested > candidate-template.
   * replay-divergence and eval-failed are Phase 5+ stubs with zero v0.2 producers.
   */
  readonly reason: ReviewReason;

  /**
   * Human-readable detail for the reason. Structured strings:
   *   - verifier-failed: pilotEvidence.verification.reason or 'verifier failed'
   *   - suspicious-detector: suspicious flag names joined by ', '
   *   - human-review-requested: 'requested by <id>'
   *   - candidate-template: proposedTemplateName + ' (candidate)'
   */
  readonly reasonDetail: string;

  /**
   * ISO 8601 timestamp of the earliest signal that enqueued this task.
   * For verifier-failed: `pilotEvidence.verification.completedAt ?? task.status.completedAt ?? task.metadata.creationTimestamp`.
   * For suspicious-detector: `task.status.completedAt ?? task.metadata.creationTimestamp`.
   * For human-review-requested: `annotations['kagent.knuteson.io/review-requested-at'] ?? task.metadata.creationTimestamp`.
   * For candidate-template: `task.status.completedAt ?? task.metadata.creationTimestamp`.
   */
  readonly enqueuedAt: string;

  /**
   * Seconds since `enqueuedAt`, computed at request time.
   * `Math.max(0, Math.floor((now - Date.parse(enqueuedAt)) / 1000))`.
   * Rows are sorted by this value descending (oldest first).
   */
  readonly stalenessSeconds: number;

  /** Current phase of the AgentTask at projection time. */
  readonly phase: AgentTaskPhase;

  /** Name of the Agent that ran this task, if known. */
  readonly targetAgent?: string | undefined;

  /** Model identifier used by this task, if known. */
  readonly model?: string | undefined;

  /**
   * Suspicious flag names from `pilotEvidence.structuralVerdict.suspicious`.
   * Present only when at least one flag is set (mirrors the task's raw field).
   */
  readonly suspicious?: readonly string[] | undefined;

  /**
   * Structured verifier failure reason from `pilotEvidence.verification.reason`.
   * Present only when `reason === 'verifier-failed'`.
   */
  readonly verifierError?: string | undefined;

  /**
   * Langfuse trace deep-link when available.
   * Carried from `pilotEvidence.traceLink` on the producing task.
   */
  readonly traceLink?: string | undefined;

  /** Count of artifacts attached to this task, if any. */
  readonly artifactCount?: number | undefined;

  /**
   * Candidate-template detail. Present only when `reason === 'candidate-template'`.
   * The accept handler validates the artifact YAML against AgentTemplateSpec
   * before creating the AgentTemplate CR (D-03-A).
   */
  readonly candidateTemplate?:
    | {
        readonly artifactRef: ArtifactRefSummary;
        readonly proposedTemplateName: string;
        readonly proposedNamespace: string;
      }
    | undefined;

  /**
   * Replay-divergence detail. Reserved for Phase 5+ / AgentTaskRun.
   * v0.2 producers: zero.
   * @see docs/REPLAY-EVALS.md
   */
  readonly replayDivergence?:
    | {
        readonly originalRunId: string;
        readonly divergenceKind: string;
      }
    | undefined;
}

/**
 * Runtime shape check — used by workbench-ui to fail fast if the API
 * payload changes. Throws a descriptive `Error` on mismatch. Does NOT
 * exhaustively validate every nested optional field; the workbench-api
 * produces the row with full type-coverage so this guard's job is to
 * detect schema drift across the substrate-API-UI boundary, not to
 * re-implement V5 input validation.
 *
 * Mirrors `assertIsDispositionOverlayRow` in disposition.ts.
 */
export function assertIsReviewQueueRow(value: unknown): asserts value is ReviewQueueRow {
  if (typeof value !== 'object' || value === null) {
    throw new Error('ReviewQueueRow: not an object');
  }
  const r = value as Record<string, unknown>;

  // taskRef — required nested object with namespace, name, uid
  if (typeof r['taskRef'] !== 'object' || r['taskRef'] === null) {
    throw new Error('ReviewQueueRow: taskRef missing or not an object');
  }
  const taskRef = r['taskRef'] as Record<string, unknown>;
  if (typeof taskRef['namespace'] !== 'string') {
    throw new Error('ReviewQueueRow: taskRef.namespace missing');
  }
  if (typeof taskRef['name'] !== 'string') {
    throw new Error('ReviewQueueRow: taskRef.name missing');
  }
  if (typeof taskRef['uid'] !== 'string') {
    throw new Error('ReviewQueueRow: taskRef.uid missing');
  }

  // reason — must be one of the 6 known ReviewReason values
  const KNOWN_REASONS: readonly string[] = [
    'verifier-failed',
    'suspicious-detector',
    'human-review-requested',
    'candidate-template',
    'replay-divergence',
    'eval-failed',
  ];
  if (typeof r['reason'] !== 'string') {
    throw new Error('ReviewQueueRow: reason missing');
  }
  if (!KNOWN_REASONS.includes(r['reason'])) {
    const rendered = r['reason'];
    throw new Error(`ReviewQueueRow: reason '${rendered}' is not a known ReviewReason`);
  }

  // reasonDetail — required string
  if (typeof r['reasonDetail'] !== 'string') {
    throw new Error('ReviewQueueRow: reasonDetail missing');
  }

  // enqueuedAt — required ISO 8601 string
  if (typeof r['enqueuedAt'] !== 'string') {
    throw new Error('ReviewQueueRow: enqueuedAt missing');
  }

  // stalenessSeconds — required non-negative number
  if (typeof r['stalenessSeconds'] !== 'number') {
    throw new Error('ReviewQueueRow: stalenessSeconds missing');
  }

  // phase — required string (AgentTaskPhase closed enum, not re-validated exhaustively here)
  if (typeof r['phase'] !== 'string') {
    throw new Error('ReviewQueueRow: phase missing');
  }

  // Optional fields: targetAgent, model, verifierError, traceLink — strings when present
  if (r['targetAgent'] !== undefined && typeof r['targetAgent'] !== 'string') {
    throw new Error('ReviewQueueRow: targetAgent must be a string when present');
  }
  if (r['model'] !== undefined && typeof r['model'] !== 'string') {
    throw new Error('ReviewQueueRow: model must be a string when present');
  }
  if (r['verifierError'] !== undefined && typeof r['verifierError'] !== 'string') {
    throw new Error('ReviewQueueRow: verifierError must be a string when present');
  }
  if (r['traceLink'] !== undefined && typeof r['traceLink'] !== 'string') {
    throw new Error('ReviewQueueRow: traceLink must be a string when present');
  }

  // artifactCount — number when present
  if (r['artifactCount'] !== undefined && typeof r['artifactCount'] !== 'number') {
    throw new Error('ReviewQueueRow: artifactCount must be a number when present');
  }

  // suspicious — array when present
  if (r['suspicious'] !== undefined && !Array.isArray(r['suspicious'])) {
    throw new Error('ReviewQueueRow: suspicious must be an array when present');
  }

  // candidateTemplate — nested object shape when present
  if (r['candidateTemplate'] !== undefined) {
    if (typeof r['candidateTemplate'] !== 'object' || r['candidateTemplate'] === null) {
      throw new Error('ReviewQueueRow: candidateTemplate must be an object when present');
    }
    const ct = r['candidateTemplate'] as Record<string, unknown>;
    if (typeof ct['artifactRef'] !== 'object' || ct['artifactRef'] === null) {
      throw new Error('ReviewQueueRow: candidateTemplate.artifactRef must be an object');
    }
    const ar = ct['artifactRef'] as Record<string, unknown>;
    if (typeof ar['uri'] !== 'string') {
      throw new Error('ReviewQueueRow: candidateTemplate.artifactRef.uri missing');
    }
    if (typeof ct['proposedTemplateName'] !== 'string') {
      throw new Error('ReviewQueueRow: candidateTemplate.proposedTemplateName missing');
    }
    if (typeof ct['proposedNamespace'] !== 'string') {
      throw new Error('ReviewQueueRow: candidateTemplate.proposedNamespace missing');
    }
  }
}

// Re-export the ArtifactRef type from crds.ts for callers that want to build
// full ArtifactRef objects alongside the summary view.
export type { ArtifactRef };
