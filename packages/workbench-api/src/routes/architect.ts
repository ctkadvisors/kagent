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
  type AgentTemplateSpec,
  type AgentTask,
} from '@kagent/dto';

import { buildArchitectMessages } from '../architect-prompt.js';
import { extractK8sStatus, readCreatedMeta } from './tasks.js';

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
const WORKBENCH_CREATED_BY = 'kagent-workbench-api';
const OPERATOR_MANAGED_BY = 'kagent-operator';
const ARCHITECT_MODEL_CLASS_ALIASES = new Set([
  'tool-caller-default',
  'text-generator-default',
  'reasoner-default',
]);

interface CreatedDraftResource {
  readonly plural: string;
  readonly namespace: string;
  readonly name: string;
}

interface NamespacedObjectDeleter {
  deleteNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
}

type DraftCreateErrorStatus = 403 | 404 | 409 | 422 | 500;

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

function normalizeArchitectAgentSpec(
  agentSpec: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const model = agentSpec['model'];
  const modelClass = agentSpec['modelClass'];
  if (
    typeof model === 'string' &&
    ARCHITECT_MODEL_CLASS_ALIASES.has(model.trim()) &&
    (typeof modelClass !== 'string' || modelClass.trim() === '')
  ) {
    const normalized = { ...agentSpec };
    delete normalized['model'];
    normalized['modelClass'] = model.trim();
    return normalized;
  }
  return { ...agentSpec };
}

function normalizeArchitectTemplateSpec(spec: AgentTemplateSpec): AgentTemplateSpec {
  return {
    ...spec,
    agentSpec: normalizeArchitectAgentSpec(spec.agentSpec),
  };
}

type ArchitectMaterializeResult =
  | { readonly ok: true; readonly agentSpec: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

const PARAM_RE = /\$\{param\.([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function architectDefaultParameterValues(spec: AgentTemplateSpec): ArchitectMaterializeResult & {
  readonly values?: Record<string, string>;
} {
  const values: Record<string, string> = {};
  for (const param of spec.parameters ?? []) {
    if (param.default !== undefined) {
      values[param.name] = param.default;
      continue;
    }
    if (param.required ?? true) {
      return {
        ok: false,
        error: `parameter "${param.name}" requires a default for Architect live try`,
      };
    }
  }
  return { ok: true, agentSpec: {}, values };
}

function renderParamRefs(value: unknown, params: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(PARAM_RE, (match, key: string) => params[key] ?? match);
  }
  if (Array.isArray(value)) return value.map((v) => renderParamRefs(v, params));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderParamRefs(v, params);
    }
    return out;
  }
  return value;
}

function resolveArchitectTools(
  spec: AgentTemplateSpec,
  params: Readonly<Record<string, string>>,
): readonly string[] {
  const allow = new Set(spec.toolAllowlist ?? []);
  let requested: readonly string[] | undefined;
  for (const param of spec.parameters ?? []) {
    if (param.type !== 'toolSelection') continue;
    const value = params[param.name];
    if (value === undefined || value.length === 0) continue;
    requested = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    break;
  }
  const candidates = requested ?? spec.toolDefaults ?? [];
  return candidates.filter((tool) => allow.has(tool));
}

function materializeArchitectAgentSpec(spec: AgentTemplateSpec): ArchitectMaterializeResult {
  const defaults = architectDefaultParameterValues(spec);
  if (!defaults.ok) return defaults;
  const rendered = renderParamRefs(spec.agentSpec, defaults.values ?? {});
  const renderedSpec: Record<string, unknown> =
    rendered !== null && typeof rendered === 'object' && !Array.isArray(rendered)
      ? (rendered as Record<string, unknown>)
      : {};
  const tools = resolveArchitectTools(spec, defaults.values ?? {});
  return {
    ok: true,
    agentSpec: {
      ...renderedSpec,
      ...(tools.length > 0 && { tools }),
    },
  };
}

function templateOwnerReferences(
  templateMeta: ReturnType<typeof readCreatedMeta>,
  fallbackName: string,
): readonly Record<string, unknown>[] | undefined {
  if (templateMeta.uid === undefined) return undefined;
  return [
    {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'AgentTemplate',
      name: templateMeta.name ?? fallbackName,
      uid: templateMeta.uid,
      controller: false,
      blockOwnerDeletion: false,
    },
  ];
}

async function cleanupCreatedDraftResources(
  customApi: CustomObjectsApi,
  resources: readonly CreatedDraftResource[],
): Promise<void> {
  const maybeDeleter = customApi as CustomObjectsApi & Partial<NamespacedObjectDeleter>;
  if (typeof maybeDeleter.deleteNamespacedCustomObject !== 'function') return;
  for (const resource of [...resources].reverse()) {
    try {
      await maybeDeleter.deleteNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: resource.namespace,
        plural: resource.plural,
        name: resource.name,
      });
    } catch (cleanupErr: unknown) {
      const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(
        '[workbench-api] POST /api/architect/try — cleanup failed',
        JSON.stringify({
          namespace: resource.namespace,
          plural: resource.plural,
          name: resource.name,
          status: extractK8sStatus(cleanupErr) ?? null,
          message: detail,
        }),
      );
    }
  }
}

function draftCreateErrorStatus(status: number | undefined): DraftCreateErrorStatus {
  if (status === 403 || status === 404 || status === 409 || status === 422) return status;
  return 500;
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
    const customApi = deps.customApi;
    if (!customApi) return c.json({ error: WRITE_DISABLED }, 503);
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

    const normalizedSpec = normalizeArchitectTemplateSpec(parsed.spec);
    const materializedAgent = materializeArchitectAgentSpec(normalizedSpec);
    if (!materializedAgent.ok) {
      return c.json({ error: 'invalid candidate', detail: materializedAgent.error }, 422);
    }
    const templateManifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'AgentTemplate',
      metadata: {
        name: templateName,
        namespace: ns,
        labels: {
          'kagent.knuteson.io/draft': 'true',
          'app.kubernetes.io/created-by': WORKBENCH_CREATED_BY,
        },
      },
      spec: normalizedSpec,
    };
    const agentManifest = {
      apiVersion: `${API_GROUP}/${API_VERSION}`,
      kind: 'Agent',
      metadata: {
        name: agentName,
        namespace: ns,
        labels: {
          'kagent.knuteson.io/draft': 'true',
          'kagent.knuteson.io/managed-by': OPERATOR_MANAGED_BY,
          'kagent.knuteson.io/from-template': templateName,
          'app.kubernetes.io/created-by': WORKBENCH_CREATED_BY,
        },
        annotations: {
          'kagent.knuteson.io/from-template': templateName,
        },
      },
      spec: materializedAgent.agentSpec,
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
          'kagent.knuteson.io/managed-by': OPERATOR_MANAGED_BY,
          'kagent.knuteson.io/from-template': templateName,
          'app.kubernetes.io/created-by': WORKBENCH_CREATED_BY,
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

    const createdResources: CreatedDraftResource[] = [];
    try {
      const createdTemplate: unknown = await customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENTTEMPLATE_PLURAL,
        body: templateManifest,
      });
      const templateMeta = readCreatedMeta(createdTemplate);
      createdResources.push({
        plural: AGENTTEMPLATE_PLURAL,
        namespace: templateMeta.namespace ?? ns,
        name: templateMeta.name ?? templateName,
      });
      const ownerReferences = templateOwnerReferences(templateMeta, templateName);
      const createdAgent: unknown = await customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENT_PLURAL,
        body: {
          ...agentManifest,
          metadata: {
            ...agentManifest.metadata,
            ...(ownerReferences !== undefined && { ownerReferences }),
          },
        },
      });
      const agentMeta = readCreatedMeta(createdAgent);
      createdResources.push({
        plural: AGENT_PLURAL,
        namespace: agentMeta.namespace ?? ns,
        name: agentMeta.name ?? agentName,
      });
      const createdTask: unknown = await customApi.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: AGENTTASK_PLURAL,
        body: {
          ...taskManifest,
          metadata: {
            ...taskManifest.metadata,
            ...(ownerReferences !== undefined && { ownerReferences }),
          },
        },
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
    } catch (err: unknown) {
      await cleanupCreatedDraftResources(customApi, createdResources);
      const status = extractK8sStatus(err);
      const responseStatus = draftCreateErrorStatus(status);
      return c.json(
        { error: 'failed to create draft resources in draft namespace' },
        responseStatus,
      );
    }
  });

  return app;
}
