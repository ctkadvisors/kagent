/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * /api/architect/* — kagent Studio "chat to create" (Phase 1).
 *
 *   POST /api/architect/draft  — NL goal → gateway LLM → AgentTemplate
 *     candidate YAML → validate via @kagent/dto parseAgentTemplateSpec →
 *     self-correct loop (re-prompt with the validator error) → return the
 *     candidate + parsed preview. READ-side: never mutates the cluster.
 *
 *   POST /api/architect/try    — take a validated candidate YAML and
 *     instantiate it as an AgentTemplate CR in the kagent-draft namespace
 *     (live iteration zone, NOT ArgoCD-managed). WRITE-side: gated on a
 *     CustomObjectsApi being configured (mirrors routes/review-queue.ts).
 *
 * Promote-to-git + lifecycle ops are Phase 2/3 (see the Studio spec).
 */
import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';
import { API_GROUP, API_VERSION, parseAgentTemplateSpec } from '@kagent/dto';

import { buildArchitectMessages } from '../architect-prompt.js';
import { readCreatedMeta } from './tasks.js';

/** Minimal surface of ArchitectClient the route needs (test-injectable). */
export interface ArchitectLike {
  complete(
    messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<string>;
}

export interface ArchitectRouteDeps {
  readonly architect: ArchitectLike;
  /** Max self-correct retries after the first attempt. Default 2. */
  readonly maxRepairs?: number;
  /** Present => /try write surface enabled; absent => 503 (same as review-queue). */
  readonly customApi?: CustomObjectsApi;
  /** Namespace drafts land in. Default 'kagent-draft'. */
  readonly draftNamespace?: string;
  /** Test seam for the instance-name suffix. */
  readonly generateName?: () => string;
}

const WRITE_DISABLED =
  'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart';

/** Strip accidental ``` fences the model may add despite instructions. */
function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:ya?ml)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'agent'
  );
}

export function architectRoute(deps: ArchitectRouteDeps): Hono {
  const app = new Hono();
  const maxRepairs = deps.maxRepairs ?? 2;

  // ── POST /draft ────────────────────────────────────────────────────
  app.post('/draft', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { goal?: unknown };
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (goal.length === 0) return c.json({ error: 'goal is required' }, 400);

    let priorYaml: string | undefined;
    let lastError = 'unknown';
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const messages =
        priorYaml === undefined
          ? buildArchitectMessages({ userGoal: goal })
          : buildArchitectMessages({ userGoal: goal, priorYaml, validationError: lastError });
      const raw = stripFences(await deps.architect.complete(messages));
      const parsed = parseAgentTemplateSpec(raw);
      if (parsed.ok) {
        return c.json({ ok: true, candidateYaml: raw, preview: parsed.spec }, 200);
      }
      priorYaml = raw;
      lastError = parsed.error;
    }
    return c.json({ error: `architect could not produce a valid candidate: ${lastError}` }, 422);
  });

  // ── POST /try ──────────────────────────────────────────────────────
  app.post('/try', async (c) => {
    if (!deps.customApi) return c.json({ error: WRITE_DISABLED }, 503);
    const ns = deps.draftNamespace ?? 'kagent-draft';
    const body = (await c.req.json().catch(() => ({}))) as {
      candidateYaml?: unknown;
      name?: unknown;
    };
    const yaml = typeof body.candidateYaml === 'string' ? body.candidateYaml : '';
    const parsed = parseAgentTemplateSpec(yaml);
    if (!parsed.ok) return c.json({ error: 'invalid candidate', detail: parsed.error }, 422);

    const base = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : 'draft';
    const suffix = (deps.generateName ?? (() => Math.random().toString(36).slice(2, 8)))();
    const name = `${slugify(base)}-${suffix}`;

    const manifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'AgentTemplate',
      metadata: {
        name,
        namespace: ns,
        labels: { 'kagent.knuteson.io/draft': 'true' },
      },
      // AgentTemplateSpec has no index signature; cast through unknown
      // (same idiom as routes/review-queue.ts accept handler).
      spec: parsed.spec as unknown as Record<string, unknown>,
    };

    try {
      const created: unknown = await deps.customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: 'agenttemplates',
        body: manifest,
      });
      const meta = readCreatedMeta(created);
      return c.json(
        {
          namespace: meta.namespace ?? ns,
          name: meta.name ?? name,
          ...(meta.uid !== undefined && { uid: meta.uid }),
          _links: { langfuse: 'https://langfuse.knuteson.io' },
        },
        201,
      );
    } catch (err) {
      const status = (err as { code?: number })?.code === 409 ? 409 : 500;
      return c.json({ error: 'failed to create AgentTemplate in draft namespace' }, status);
    }
  });

  return app;
}
