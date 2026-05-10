/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * GET /api/review-queue — Phase 4 / REV-01 read projection.
 * POST /api/review-queue/:ns/:name/accept|reject|request — Phase 4 / REV-02 write path.
 *
 * GET handler:
 *   Computes per-AgentTask review-queue rows from the SnapshotCache.
 *   Pure-read; no K8s API calls.
 *
 * POST handlers (Plan 04-03 W2):
 *   accept  — 5-step path: 503 → 404 → 409 → (candidate: parse+create CR) → patch annotation → emit events
 *   reject  — 3-step path: 503 → 404 → 409 → patch annotation → emit review.rejected
 *   request — 3-step path: 503 → 404 → patch annotation → emit review.requested
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
 * @see REQUIREMENTS.md REV-01, REV-02, REV-03
 * @see CONTEXT.md D-01-A, D-02-A, D-03-A, D-06
 * @see PATTERNS.md W1.1, W2.1, W2.2
 * @see RESEARCH.md Q3, Q4, Q11
 */

import { Hono } from 'hono';
import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';
import {
  assertIsReviewQueueRow,
  parseAgentTemplateSpec,
  type ArtifactRefSummary,
  type ReviewQueueRow,
} from '@kagent/dto';
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
import { scrubSecrets } from '../error-scrub.js';
import { extractK8sStatus, readCreatedMeta } from './tasks.js';

// Suppress false-positive "unused" warnings from TypeScript for re-exported
// symbols that are not yet called within this file.
void assertIsReviewQueueRow;

/**
 * MERGE_PATCH_OPTIONS: content-type header for K8s JSON merge-patch
 * annotation write operations (PATTERNS.md W2.1 / gateway.ts:48 analog).
 * Without this, the K8s client defaults to RFC 6902 JSON-Patch and
 * rejects the merge-shaped body.
 */
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');

/** Verbatim 503 message — tests grep for this exact string (tasks.ts:147 precedent). */
const WRITE_DISABLED_MESSAGE =
  'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart';

/** K8s group / version for kagent resources. */
const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';

/** Known annotation keys. */
const ANNOTATION_REVIEW_DECISION = 'kagent.knuteson.io/review-decision';
const ANNOTATION_REVIEW_DECIDED_BY = 'kagent.knuteson.io/review-decided-by';
const ANNOTATION_REVIEW_DECIDED_AT = 'kagent.knuteson.io/review-decided-at';
const ANNOTATION_REVIEW_REQUESTED = 'kagent.knuteson.io/review-requested';
const ANNOTATION_REVIEW_REQUESTED_BY = 'kagent.knuteson.io/review-requested-by';
const ANNOTATION_REVIEW_REQUESTED_AT = 'kagent.knuteson.io/review-requested-at';
const ANNOTATION_TEMPLATE_CANDIDATE = 'kagent.knuteson.io/template-candidate';
const ANNOTATION_PROPOSED_TEMPLATE_NAME = 'kagent.knuteson.io/proposed-template-name';
const ANNOTATION_PROMOTED_FROM_TASK = 'kagent.knuteson.io/promoted-from-task';

/** MediaType that identifies a candidate AgentTemplate artifact. */
const TEMPLATE_CANDIDATE_MEDIA_TYPE = 'application/x-kagent-template-candidate+yaml';

/** X-Forwarded-User header name (mirrors auth.ts posture). */
const FORWARDED_USER_HEADER = 'X-Forwarded-User';

export interface ReviewQueueRouteDeps {
  /** Required: source of task snapshots. */
  readonly cache: SnapshotCache;
  /** Optional: K8s write client for POST handlers. */
  readonly customApi?: CustomObjectsApi;
  /**
   * Optional audit publisher for POST write events
   * (review.accepted, review.rejected, review.requested,
   * template.candidate.promoted). The GET handler emits no audit events.
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /** Test-injectable clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Default namespace for promotion writes. */
  readonly defaultNamespace?: string;
  /** Langfuse base URL for trace deep-links in the review row. */
  readonly langfuseBaseUrl?: string;
  /** Logger surface. Defaults to console.warn / console.error. */
  readonly logger?: { warn(message: string): void; error?(message: string): void };
  /**
   * Test-injectable artifact reader. When present, the accept handler
   * calls this instead of attempting PVC resolution to read the
   * candidate-template YAML payload.
   *
   * Production (v0.2): not supplied — the accept handler reads the YAML
   * from the artifact's `payloadBase64` field (inline base64) or returns
   * 422 when that field is absent. PVC resolution is deferred to v0.3
   * pending the artifact-store client.
   *
   * Tests supply a mock: `readArtifact: () => Promise.resolve(candidateYaml)`.
   */
  readonly readArtifact?: (artifactUri: string) => Promise<string>;
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
  const logError =
    deps.logger?.error !== undefined
      ? (m: string): void => {
          deps.logger!.error!(m);
        }
      : (m: string): void => {
          console.error(m);
        };

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
  // POST /:namespace/:name/accept — REV-02 accept path (5-step).
  //
  // CONTEXT.md D-03-A step order (LOAD-BEARING — tests assert call order):
  //   1. 503 fail-closed if no customApi
  //   2. Cache-lookup → 404
  //   3. Conflict-check → 409 if review-decision already set
  //   4. Body parse + reviewer-id resolution
  //   5. Re-classify via classifyTask → 409 if task no longer in queue
  //   6. (candidate-template only): parse YAML → create AgentTemplate CR
  //   7. PATCH AgentTask annotations (AFTER CR creation — D-03 atomicity)
  //   8. Emit audit events (best-effort; swallow-and-log per dispositions.ts precedent)
  //   9. Respond 200
  // ------------------------------------------------------------------
  app.post('/:namespace/:name/accept', async (c) => {
    // Step 1 — fail-closed
    if (deps.customApi === undefined) {
      return c.json({ error: WRITE_DISABLED_MESSAGE }, 503);
    }

    const namespace = c.req.param('namespace');
    const name = c.req.param('name');

    // Step 2 — cache lookup → 404
    const task = deps.cache.getTask(namespace, name);
    if (task === undefined) {
      return c.json({ error: `AgentTask ${namespace}/${name} not in cache`, namespace, name }, 404);
    }

    // Step 3 — conflict check → 409 if already decided
    const annotations: Record<string, string> =
      (task.metadata?.annotations as Record<string, string> | undefined) ?? {};
    if (annotations[ANNOTATION_REVIEW_DECISION] !== undefined) {
      return c.json(
        {
          error: `AgentTask ${namespace}/${name} already has a review decision`,
          existing: annotations[ANNOTATION_REVIEW_DECISION],
        },
        409,
      );
    }

    // Step 4 — body parse + reviewer-id resolution
    let body: { reviewerId?: string; reasonText?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // tolerate missing or malformed body — all fields are optional
    }
    const reviewerId = extractReviewerId(c, body);
    const reasonText = typeof body.reasonText === 'string' ? body.reasonText : undefined;

    // Step 5 — re-classify: verify task is still in queue (atomicity guard)
    const nowMs = now().getTime();
    const row = classifyTask(task, nowMs, deps.langfuseBaseUrl, deps.defaultNamespace);
    if (row === undefined) {
      return c.json({ error: 'task is not in review queue' }, 409);
    }

    const nowIso = new Date(nowMs).toISOString();
    const taskRef = row.taskRef;
    let agentTemplateRef: { name?: string; namespace?: string; uid?: string } | undefined;

    // Step 6 — (candidate-template only) parse YAML → create AgentTemplate CR
    if (row.reason === 'candidate-template') {
      const candidateArtifact = findCandidateArtifact(task);
      if (candidateArtifact === undefined) {
        return c.json({ error: 'candidate-template artifact not found on task' }, 422);
      }

      // Read the artifact YAML payload via injectable seam or inline base64.
      let yaml: string;
      try {
        if (deps.readArtifact !== undefined) {
          yaml = await deps.readArtifact(candidateArtifact.artifactRef.uri);
        } else {
          // v0.2 production fallback: inline payloadBase64 field (if present).
          // PVC resolution is deferred to v0.3. See JSDoc on readArtifact dep.
          const artifactObj = candidateArtifact.artifactRef as unknown as Record<string, unknown>;
          const b64 = artifactObj['payloadBase64'];
          if (typeof b64 === 'string') {
            yaml = Buffer.from(b64, 'base64').toString('utf8');
          } else {
            return c.json(
              {
                error:
                  'candidate-template artifact YAML not available (no readArtifact dep and no payloadBase64 field); PVC resolution deferred to v0.3',
              },
              422,
            );
          }
        }
      } catch (readErr) {
        logError(
          `[workbench-api] accept: artifact read error — ${
            readErr instanceof Error ? readErr.message : String(readErr)
          }`,
        );
        return c.json(
          { error: 'internal error reading candidate-template artifact; see workbench-api logs' },
          500,
        );
      }

      const parsed = parseAgentTemplateSpec(yaml);
      if (!parsed.ok) {
        return c.json({ error: 'candidate-template parse failed', detail: parsed.error }, 422);
      }

      // Build AgentTemplate CR manifest (PATTERNS.md W2.1 manifest shape)
      const taskUid = typeof task.metadata?.uid === 'string' ? task.metadata.uid : '';
      const proposedTemplateName =
        row.candidateTemplate?.proposedTemplateName ?? `${name}-template`;
      const proposedNamespace = row.candidateTemplate?.proposedNamespace ?? namespace;

      const manifest = buildAgentTemplateManifest({
        proposedTemplateName,
        proposedNamespace,
        taskNamespace: namespace,
        taskName: name,
        taskUid,
        // Cast AgentTemplateSpec → Record<string,unknown> via unknown (no index sig on spec type)
        spec: parsed.spec as unknown as Record<string, unknown>,
      });

      // Create the AgentTemplate CR (FIRST — D-03 atomicity: CR creation before annotation patch)
      try {
        const created: unknown = await deps.customApi.createNamespacedCustomObject({
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace: proposedNamespace,
          plural: 'agenttemplates',
          body: manifest,
        });
        agentTemplateRef = readCreatedMeta(created);
      } catch (createErr) {
        const status = extractK8sStatus(createErr);
        const errBody =
          createErr !== null &&
          typeof createErr === 'object' &&
          'body' in createErr &&
          typeof (createErr as Record<string, unknown>)['body'] === 'string'
            ? scrubSecrets((createErr as Record<string, unknown>)['body'] as string)
            : createErr instanceof Error
              ? scrubSecrets(createErr.message)
              : 'unknown error';

        if (status === 409 || status === 422) {
          return c.json({ error: 'AgentTemplate creation failed', detail: errBody }, 422);
        }
        if (status === 403) {
          return c.json({ error: 'forbidden: RBAC denied AgentTemplate creation' }, 403);
        }
        logError(
          `[workbench-api] POST accept — unhandled K8s error creating AgentTemplate: ${JSON.stringify({ namespace, name, status: status ?? null })}`,
        );
        return c.json(
          { error: 'internal error processing review accept; see workbench-api logs' },
          500,
        );
      }
    }

    // CR-01 fix (Plan 04-06): emit template.candidate.promoted IMMEDIATELY
    // after CR-create success, BEFORE the annotation patch. This preserves
    // the audit record of the AgentTemplate's existence even when the
    // subsequent patch step fails (audit consumers can later join to
    // review.accepted once it fires on the patch-success path).
    if (
      row.reason === 'candidate-template' &&
      agentTemplateRef !== undefined &&
      deps.auditPublisher !== undefined
    ) {
      const promotedRef = {
        namespace: agentTemplateRef.namespace ?? '',
        name: agentTemplateRef.name ?? '',
        uid: agentTemplateRef.uid,
      };
      try {
        await deps.auditPublisher.publish(
          makeEvent({
            type: TEMPLATE_CANDIDATE_PROMOTED,
            source: 'kagent.knuteson.io/workbench-api',
            subject: `AgentTask/${namespace}/${name}`,
            data: {
              taskRef,
              agentTemplateRef: promotedRef,
              reviewerId,
            },
          }),
        );
      } catch (auditErr) {
        logWarn(
          `review-queue: template.candidate.promoted publish failed: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }
    }

    // Step 7 — PATCH AgentTask annotations (SECOND — after CR creation per D-03 atomicity)
    try {
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: 'agenttasks',
          name,
          body: {
            metadata: {
              annotations: {
                [ANNOTATION_REVIEW_DECISION]: 'accepted',
                [ANNOTATION_REVIEW_DECIDED_BY]: reviewerId ?? 'unknown',
                [ANNOTATION_REVIEW_DECIDED_AT]: nowIso,
              },
            },
          },
        },
        MERGE_PATCH_OPTIONS,
      );
    } catch (patchErr) {
      logError(
        `[workbench-api] POST accept — annotation patch failed: ${JSON.stringify({ namespace, name, err: patchErr instanceof Error ? patchErr.message : String(patchErr) })}`,
      );
      return c.json({ error: 'patch annotation failed', detail: 'see workbench-api logs' }, 500);
    }

    // Step 8 — emit audit events (best-effort; swallow-and-log per dispositions.ts:282-302)
    if (deps.auditPublisher !== undefined) {
      try {
        await deps.auditPublisher.publish(
          makeEvent({
            type: REVIEW_ACCEPTED,
            source: 'kagent.knuteson.io/workbench-api',
            subject: `AgentTask/${namespace}/${name}`,
            data: {
              taskRef,
              reason: row.reason,
              // ReviewAcceptedData requires reviewerId/reasonText as `string | undefined` (not omitted)
              reviewerId,
              reasonText,
            },
          }),
        );
      } catch (auditErr) {
        logWarn(
          `review-queue: review.accepted publish failed: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }
    }

    // Step 9 — respond 200
    return c.json({
      taskRef,
      decision: 'accepted',
      auditedAt: nowIso,
      ...(agentTemplateRef !== undefined && { agentTemplateRef }),
    });
  });

  // ------------------------------------------------------------------
  // POST /:namespace/:name/reject — REV-02 reject path.
  //
  // Steps:
  //   1. 503 fail-closed
  //   2. Cache-lookup → 404
  //   3. Conflict-check → 409
  //   4. Body parse + reviewer-id resolution
  //   5. Re-classify → 409 if no longer in queue
  //   6. PATCH review-decision: rejected
  //   7. Emit review.rejected
  //   8. Respond 200
  //
  // NEVER creates an AgentTemplate CR under any reason.
  // ------------------------------------------------------------------
  app.post('/:namespace/:name/reject', async (c) => {
    // Step 1 — fail-closed
    if (deps.customApi === undefined) {
      return c.json({ error: WRITE_DISABLED_MESSAGE }, 503);
    }

    const namespace = c.req.param('namespace');
    const name = c.req.param('name');

    // Step 2 — cache lookup → 404
    const task = deps.cache.getTask(namespace, name);
    if (task === undefined) {
      return c.json({ error: `AgentTask ${namespace}/${name} not in cache`, namespace, name }, 404);
    }

    // Step 3 — conflict check → 409 if already decided
    const annotations: Record<string, string> =
      (task.metadata?.annotations as Record<string, string> | undefined) ?? {};
    if (annotations[ANNOTATION_REVIEW_DECISION] !== undefined) {
      return c.json(
        {
          error: `AgentTask ${namespace}/${name} already has a review decision`,
          existing: annotations[ANNOTATION_REVIEW_DECISION],
        },
        409,
      );
    }

    // Step 4 — body parse + reviewer-id resolution
    let body: { reviewerId?: string; reasonText?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // tolerate missing or malformed body
    }
    const reviewerId = extractReviewerId(c, body);
    const reasonText = typeof body.reasonText === 'string' ? body.reasonText : undefined;

    // Step 5 — re-classify: verify task is still in queue
    const nowMs = now().getTime();
    const row = classifyTask(task, nowMs, deps.langfuseBaseUrl, deps.defaultNamespace);
    if (row === undefined) {
      return c.json({ error: 'task is not in review queue' }, 409);
    }

    const nowIso = new Date(nowMs).toISOString();
    const taskRef = row.taskRef;

    // Step 6 — PATCH review-decision: rejected
    try {
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: 'agenttasks',
          name,
          body: {
            metadata: {
              annotations: {
                [ANNOTATION_REVIEW_DECISION]: 'rejected',
                [ANNOTATION_REVIEW_DECIDED_BY]: reviewerId ?? 'unknown',
                [ANNOTATION_REVIEW_DECIDED_AT]: nowIso,
              },
            },
          },
        },
        MERGE_PATCH_OPTIONS,
      );
    } catch (patchErr) {
      logError(
        `[workbench-api] POST reject — annotation patch failed: ${JSON.stringify({ namespace, name, err: patchErr instanceof Error ? patchErr.message : String(patchErr) })}`,
      );
      return c.json({ error: 'patch annotation failed', detail: 'see workbench-api logs' }, 500);
    }

    // Step 7 — emit review.rejected (best-effort)
    if (deps.auditPublisher !== undefined) {
      try {
        await deps.auditPublisher.publish(
          makeEvent({
            type: REVIEW_REJECTED,
            source: 'kagent.knuteson.io/workbench-api',
            subject: `AgentTask/${namespace}/${name}`,
            data: {
              taskRef,
              reason: row.reason,
              // ReviewRejectedData requires reviewerId/reasonText as `string | undefined`
              reviewerId,
              reasonText,
            },
          }),
        );
      } catch (auditErr) {
        logWarn(
          `review-queue: review.rejected publish failed: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }
    }

    // Step 8 — respond 200
    return c.json({ taskRef, decision: 'rejected', auditedAt: nowIso });
  });

  // ------------------------------------------------------------------
  // POST /:namespace/:name/request — REV-02 request path.
  //
  // Steps:
  //   1. 503 fail-closed
  //   2. Cache-lookup → 404
  //   3. Idempotency: 409 if review-decision OR review-requested already set
  //   4. Body parse + reviewer-id resolution
  //   5. PATCH review-requested: "true" + companions
  //   6. Emit review.requested
  //   7. Respond 200
  //
  // D-06 enforcement: this endpoint is the ONLY way to write
  // review-requested. Agents never write this annotation directly.
  // ------------------------------------------------------------------
  app.post('/:namespace/:name/request', async (c) => {
    // Step 1 — fail-closed
    if (deps.customApi === undefined) {
      return c.json({ error: WRITE_DISABLED_MESSAGE }, 503);
    }

    const namespace = c.req.param('namespace');
    const name = c.req.param('name');

    // Step 2 — cache lookup → 404
    const task = deps.cache.getTask(namespace, name);
    if (task === undefined) {
      return c.json({ error: `AgentTask ${namespace}/${name} not in cache`, namespace, name }, 404);
    }

    // Step 3 — idempotency: 409 if already decided or already requested
    const annotations: Record<string, string> =
      (task.metadata?.annotations as Record<string, string> | undefined) ?? {};
    if (annotations[ANNOTATION_REVIEW_DECISION] !== undefined) {
      return c.json(
        {
          error: `AgentTask ${namespace}/${name} already has a review decision`,
          existing: annotations[ANNOTATION_REVIEW_DECISION],
        },
        409,
      );
    }
    if (annotations[ANNOTATION_REVIEW_REQUESTED] === 'true') {
      return c.json(
        { error: `AgentTask ${namespace}/${name} already has review-requested=true` },
        409,
      );
    }

    // Step 4 — body parse + reviewer-id resolution
    let body: { reviewerId?: string; reasonText?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // tolerate missing or malformed body
    }
    const reviewerId = extractReviewerId(c, body);
    const reasonText = typeof body.reasonText === 'string' ? body.reasonText : undefined;

    const nowMs = now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const uid = typeof task.metadata?.uid === 'string' ? task.metadata.uid : '';
    const taskRef = { namespace, name, uid } as const;

    // Step 5 — PATCH review-requested: "true" + companion annotations
    try {
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: 'agenttasks',
          name,
          body: {
            metadata: {
              annotations: {
                [ANNOTATION_REVIEW_REQUESTED]: 'true',
                [ANNOTATION_REVIEW_REQUESTED_BY]: reviewerId ?? 'unknown',
                [ANNOTATION_REVIEW_REQUESTED_AT]: nowIso,
              },
            },
          },
        },
        MERGE_PATCH_OPTIONS,
      );
    } catch (patchErr) {
      logError(
        `[workbench-api] POST request — annotation patch failed: ${JSON.stringify({ namespace, name, err: patchErr instanceof Error ? patchErr.message : String(patchErr) })}`,
      );
      return c.json({ error: 'patch annotation failed', detail: 'see workbench-api logs' }, 500);
    }

    // Step 6 — emit review.requested (best-effort)
    if (deps.auditPublisher !== undefined) {
      try {
        await deps.auditPublisher.publish(
          makeEvent({
            type: REVIEW_REQUESTED,
            source: 'kagent.knuteson.io/workbench-api',
            subject: `AgentTask/${namespace}/${name}`,
            data: {
              taskRef,
              // ReviewRequestedData requires reviewerId/reasonText as `string | undefined`
              reviewerId,
              reasonText,
            },
          }),
        );
      } catch (auditErr) {
        logWarn(
          `review-queue: review.requested publish failed: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`,
        );
      }
    }

    // Step 7 — respond 200
    return c.json({ taskRef, requested: true, requestedAt: nowIso });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Module-scope helpers (pure functions — no I/O, no side effects)
// ---------------------------------------------------------------------------

/**
 * Extract reviewer ID from the request context.
 *
 * Resolution order (CONTEXT.md D-03-A / PATTERNS.md W2.1):
 *   1. Body-supplied `reviewerId` (operator override)
 *   2. `X-Forwarded-User` header (upstream auth shim)
 *   3. `c.var.user` from auth middleware (set by buildAuthMiddleware)
 *   4. Returns `undefined` when none present — callers substitute 'unknown'
 *      for annotation/audit fields but don't include in structured data.
 */
function extractReviewerId(
  c: {
    req: { header(name: string): string | undefined };
    var: Record<string, unknown> | undefined;
  },
  body: { reviewerId?: string },
): string | undefined {
  if (typeof body.reviewerId === 'string' && body.reviewerId.trim().length > 0) {
    return body.reviewerId.trim();
  }
  const fromHeader = c.req.header(FORWARDED_USER_HEADER)?.trim();
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  const fromVar = c.var;
  if (typeof fromVar?.['user'] === 'string' && fromVar['user'].length > 0) {
    return fromVar['user'];
  }
  return undefined;
}

interface AgentTemplateManifestArgs {
  readonly proposedTemplateName: string;
  readonly proposedNamespace: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly taskUid: string;
  readonly spec: Record<string, unknown>;
}

/**
 * Build the AgentTemplate CR manifest from the accepted candidate.
 * Pure function — no I/O. Builds per CONTEXT.md D-03-A manifest spec.
 */
function buildAgentTemplateManifest(args: AgentTemplateManifestArgs): Record<string, unknown> {
  return {
    apiVersion: `${KAGENT_GROUP}/${KAGENT_VERSION}`,
    kind: 'AgentTemplate',
    metadata: {
      name: args.proposedTemplateName,
      namespace: args.proposedNamespace,
      annotations: {
        [ANNOTATION_PROMOTED_FROM_TASK]: `${args.taskNamespace}/${args.taskName}`,
      },
      ownerReferences: [
        {
          apiVersion: `${KAGENT_GROUP}/${KAGENT_VERSION}`,
          kind: 'AgentTask',
          name: args.taskName,
          uid: args.taskUid,
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: args.spec,
  };
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
