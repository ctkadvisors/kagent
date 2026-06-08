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
 *   POST /api/architect/try    — take a validated candidate YAML,
 *     persist it as an AgentTemplate CR, materialize a draft Agent, and
 *     create an AgentTask in the kagent-draft namespace (live iteration
 *     zone, NOT ArgoCD-managed). WRITE-side: gated on a CustomObjectsApi
 *     being configured (mirrors routes/review-queue.ts).
 *
 * Promote-to-git + lifecycle ops are Phase 2/3 (see the Studio spec).
 */
import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  parseAgentTemplateSpec,
  traceLink,
  type AgentTask,
} from '@kagent/dto';

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
  /** Browser-reachable Langfuse base URL for the created AgentTask trace link. */
  readonly langfuseBaseUrl?: string;
  /** Test seam for the instance-name suffix. */
  readonly generateName?: () => string;
}

const WRITE_DISABLED =
  'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart';
const AGENTTEMPLATE_PLURAL = 'agenttemplates';
const AGENT_PLURAL = 'agents';
const AGENTTASK_PLURAL = 'agenttasks';

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
      goal?: unknown;
      name?: unknown;
    };
    const yaml = typeof body.candidateYaml === 'string' ? body.candidateYaml : '';
    const parsed = parseAgentTemplateSpec(yaml);
    if (!parsed.ok) return c.json({ error: 'invalid candidate', detail: parsed.error }, 422);

    const base = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : 'draft';
    const suffix = (deps.generateName ?? (() => Math.random().toString(36).slice(2, 8)))();
    const templateName = `${slugify(base)}-${suffix}`;
    const agentName = `${templateName}-agent`;
    const taskName = `${templateName}-run`;
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';

    const templateManifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'AgentTemplate',
      metadata: {
        name: templateName,
        namespace: ns,
        labels: { 'kagent.knuteson.io/draft': 'true' },
      },
      // AgentTemplateSpec has no index signature; cast through unknown
      // (same idiom as routes/review-queue.ts accept handler).
      spec: parsed.spec as unknown as Record<string, unknown>,
    };
    const agentManifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'Agent',
      metadata: {
        name: agentName,
        namespace: ns,
        labels: {
          'kagent.knuteson.io/draft': 'true',
          'app.kubernetes.io/created-by': 'kagent-workbench-api',
        },
        annotations: {
          'kagent.knuteson.io/from-template': templateName,
        },
      },
      spec: { ...parsed.spec.agentSpec },
    };
    const runConfig: Record<string, unknown> = {};
    if (parsed.spec.budget?.maxIterations !== undefined) {
      runConfig.maxIterations = parsed.spec.budget.maxIterations;
    }
    if (parsed.spec.budget?.maxCostUsdPerRun !== undefined) {
      runConfig.costLimitUsd = parsed.spec.budget.maxCostUsdPerRun;
    }
    const taskManifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'AgentTask',
      metadata: {
        name: taskName,
        namespace: ns,
        labels: {
          'kagent.knuteson.io/draft': 'true',
          'app.kubernetes.io/created-by': 'kagent-workbench-api',
        },
        annotations: {
          'kagent.knuteson.io/from-template': templateName,
        },
      },
      spec: {
        targetAgent: agentName,
        originalUserMessage: goal.length > 0 ? goal : `Run draft agent ${agentName}`,
        payload: {
          ...(goal.length > 0 && { goal }),
          candidateYaml: yaml,
          templateName,
        },
        ...(Object.keys(runConfig).length > 0 && { runConfig }),
      },
    };

    try {
      const createdTemplate: unknown = await deps.customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENTTEMPLATE_PLURAL,
        body: templateManifest,
      });
      const templateMeta = readCreatedMeta(createdTemplate);
      const createdAgent: unknown = await deps.customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENT_PLURAL,
        body: agentManifest,
      });
      const agentMeta = readCreatedMeta(createdAgent);
      const createdTask: unknown = await deps.customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENTTASK_PLURAL,
        body: taskManifest,
      });
      const taskMeta = readCreatedMeta(createdTask);
      const taskRef = {
        apiVersion: `${API_GROUP}/${API_VERSION}`,
        kind: 'AgentTask',
        metadata: {
          namespace: taskMeta.namespace ?? ns,
          name: taskMeta.name ?? taskName,
          ...(taskMeta.uid !== undefined && { uid: taskMeta.uid }),
        },
        spec: { targetAgent: agentMeta.name ?? agentName, payload: {} },
      } as AgentTask;
      const langfuse = traceLink(taskRef, {
        provider: 'langfuse',
        ...(deps.langfuseBaseUrl !== undefined && { baseUrl: deps.langfuseBaseUrl }),
      });
      return c.json(
        {
          namespace: taskMeta.namespace ?? ns,
          name: taskMeta.name ?? taskName,
          ...(taskMeta.uid !== undefined && { uid: taskMeta.uid }),
          templateName: templateMeta.name ?? templateName,
          ...(templateMeta.uid !== undefined && { templateUid: templateMeta.uid }),
          agentName: agentMeta.name ?? agentName,
          ...(agentMeta.uid !== undefined && { agentUid: agentMeta.uid }),
          taskName: taskMeta.name ?? taskName,
          ...(taskMeta.uid !== undefined && { taskUid: taskMeta.uid }),
          _links: {
            detail: `/api/tasks/${encodeURIComponent(taskMeta.namespace ?? ns)}/${encodeURIComponent(taskMeta.name ?? taskName)}`,
            ui: `/#/tasks/${encodeURIComponent(taskMeta.namespace ?? ns)}/${encodeURIComponent(taskMeta.name ?? taskName)}`,
            ...(langfuse?.url !== undefined && { langfuse: langfuse.url }),
          },
        },
        201,
      );
    } catch (err) {
      const status = (err as { code?: number })?.code === 409 ? 409 : 500;
      return c.json({ error: 'failed to create draft AgentTask in draft namespace' }, status);
    }
  });

  return app;
}
