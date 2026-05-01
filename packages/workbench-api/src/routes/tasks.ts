/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `GET /api/tasks` and `GET /api/tasks/:namespace/:name` —
 * the read surface for the Workbench's TaskList + TaskDetail views.
 *
 * Both endpoints serve from the in-memory `SnapshotCache`. The DTO
 * mappers (`@kagent/dto`) project K8s objects → UI-friendly shapes;
 * this route does NO derivation logic of its own beyond joining
 * Task ↔ Agent ↔ Job ↔ Pod by namespace/name + label.
 *
 * Filters supported (query string):
 *
 *   - `namespace=<ns>` — limit to one namespace.
 *   - `phase=Pending|Dispatched|Completed|Failed` — repeat for OR.
 *   - `targetAgent=<name>` — exact match.
 *   - `since=<ISO 8601>` — only tasks with creationTimestamp >= since.
 *
 * Sort: descending by creationTimestamp. The list view's "newest
 * first" expectation is hardcoded here so the UI doesn't have to
 * carry sort state until pagination lands in v0.2.
 *
 * `POST /api/tasks` — WS-J write surface. Creates an AgentTask CR via
 * the K8s API and returns 201 with the created object's identity. The
 * operator's existing informer picks it up and dispatches; the cache /
 * SSE stream surfaces the new row to the UI within a few seconds. The
 * RBAC delta (`agenttasks: [create]`) lives in the workbench chart's
 * separate `actions` ClusterRole — kept distinct from the read role so
 * a `actions.create=false` install is provably write-proof.
 */

import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import {
  API_GROUP_VERSION,
  taskDetail,
  taskSummary,
  traceLink,
  type TaskSummary,
} from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';
import type { CreateTaskErrorBody, CreateTaskResponse } from '../types-write.js';
import { validateCreateTaskBody, type ValidationError } from './validators.js';

export interface TasksRouteDeps {
  readonly cache: SnapshotCache;
  /**
   * Optional Langfuse base URL. When set, the detail response carries
   * a `traceLink` field with a deep-link the UI can render. The DTO
   * mapper derives the OTel trace ID from the AgentTask UID (mirror of
   * `traceIdFromRunId` in `@kagent/trace-sinks`); the base URL is just
   * the `<scheme>://<host>` prefix.
   */
  readonly langfuseBaseUrl?: string;
  /**
   * K8s CustomObjects client used by the POST handler to create
   * AgentTask CRs. When omitted, POST returns 503 with a clear "write
   * surface disabled" body — useful for read-only deployments and for
   * test harnesses that don't want to mock the K8s client.
   */
  readonly customApi?: CustomObjectsApi;
  /**
   * Default namespace for POST when the request omits one. In the chart
   * this is the workbench-api's release namespace (typically
   * `kagent-system`); in tests it's whatever the harness sets.
   */
  readonly defaultNamespace?: string;
  /**
   * Identity-generator for AgentTask names when the request body omits
   * `name`. Test-injectable; production uses a small nanoid-like impl.
   */
  readonly generateName?: () => string;
}

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTTASK_PLURAL = 'agenttasks';

/**
 * Generate an 8-char URL-safe ID. Crypto-grade not required (collisions
 * surface as 409 from K8s and the handler retries-via-error-to-caller),
 * but Math.random would be insufficient under concurrent submissions —
 * use crypto.getRandomValues for the ~5e7-keyspace lookup.
 */
function defaultGenerateName(): string {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(8);
  // globalThis.crypto is available in Node 18+ and the browser; the
  // workbench-api targets Node 22 so this is safe without a polyfill.
  globalThis.crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += ALPHA[b % ALPHA.length];
  return `manual-${s}`;
}

export function tasksRoute(deps: TasksRouteDeps): Hono {
  const app = new Hono();

  app.get('/api/tasks', (c) => {
    const url = new URL(c.req.url);
    const ns = url.searchParams.get('namespace') ?? undefined;
    const phases = url.searchParams.getAll('phase');
    const targetAgent = url.searchParams.get('targetAgent') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const sinceMs = since !== null && since !== undefined ? Date.parse(since) : NaN;

    const tasks = deps.cache.listTasks();
    const summaries: TaskSummary[] = tasks
      .filter((t) => {
        if (ns !== undefined && (t.metadata.namespace ?? 'default') !== ns) return false;
        if (
          phases.length > 0 &&
          (t.status?.phase === undefined || !phases.includes(t.status.phase))
        )
          return false;
        if (targetAgent !== undefined && t.spec.targetAgent !== targetAgent) return false;
        if (!Number.isNaN(sinceMs)) {
          const created = t.metadata.creationTimestamp;
          if (created === undefined) return false;
          const createdMs = typeof created === 'string' ? Date.parse(created) : created.getTime();
          if (createdMs < sinceMs) return false;
        }
        return true;
      })
      .map((t) => {
        const ns2 = t.metadata.namespace ?? 'default';
        const agentName = t.spec.targetAgent;
        const agent = agentName !== undefined ? deps.cache.getAgent(ns2, agentName) : undefined;
        return taskSummary(t, { ...(agent !== undefined && { agent }) });
      })
      .sort((a, b) => compareIsoDesc(a.createdAt, b.createdAt));

    return c.json({ items: summaries });
  });

  app.post('/api/tasks', async (c) => {
    if (deps.customApi === undefined) {
      const body: CreateTaskErrorBody = {
        error:
          'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
      };
      return c.json(body, 503);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const body: CreateTaskErrorBody = { error: 'request body is not valid JSON' };
      return c.json(body, 400);
    }

    const result = validateCreateTaskBody(raw);
    if (!result.valid || result.value === undefined) {
      const body: CreateTaskErrorBody = {
        error: 'request body failed validation',
        fields: result.errors.map(formatFieldError),
      };
      // 400 for any malformed input (missing/empty/wrong-type/invalid-name);
      // 422 reserved for "shape correct, semantically out-of-range".
      const has400 = result.errors.some(
        (e) =>
          e.code === 'missing' ||
          e.code === 'empty' ||
          e.code === 'wrong-type' ||
          e.code === 'invalid-name' ||
          e.code === 'too-long',
      );
      return c.json(body, has400 ? 400 : 422);
    }
    const req = result.value;

    const namespace = req.namespace ?? deps.defaultNamespace ?? 'default';
    const name = req.name ?? (deps.generateName ?? defaultGenerateName)();

    // Existence pre-check — the cache may not see an Agent that exists
    // in another namespace until the informer catches up, so a `null`
    // here is a soft "we haven't seen it"; the K8s API call below is
    // the authoritative check via owner-side errors. We only short-
    // circuit when the cache has an opinion AND the answer is "no
    // agent in this namespace by that name."
    const agent = deps.cache.getAgent(namespace, req.targetAgent);
    if (agent === undefined && hasNamespaceLoadedAgents(deps.cache, namespace)) {
      const body: CreateTaskErrorBody = {
        error: `agent "${req.targetAgent}" not found in namespace "${namespace}"`,
      };
      return c.json(body, 404);
    }

    const manifest: Record<string, unknown> = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: {
        name,
        namespace,
        labels: {
          'kagent.knuteson.io/managed-by': 'kagent-operator',
          'app.kubernetes.io/created-by': 'kagent-workbench-api',
          ...(req.labels ?? {}),
        },
      },
      spec: {
        targetAgent: req.targetAgent,
        originalUserMessage: req.originalUserMessage,
        payload: req.payload ?? {},
        ...(req.runConfig !== undefined && { runConfig: req.runConfig }),
      },
    };

    try {
      const created: unknown = await deps.customApi.createNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace,
        plural: AGENTTASK_PLURAL,
        body: manifest,
      });
      const meta = readCreatedMeta(created);
      const response: CreateTaskResponse = {
        namespace: meta.namespace ?? namespace,
        name: meta.name ?? name,
        uid: meta.uid ?? '',
        createdAt: meta.creationTimestamp ?? new Date().toISOString(),
        phase: 'Pending',
        _links: {
          detail: `/api/tasks/${encodeURIComponent(meta.namespace ?? namespace)}/${encodeURIComponent(meta.name ?? name)}`,
          ui: `/#/tasks/${encodeURIComponent(meta.namespace ?? namespace)}/${encodeURIComponent(meta.name ?? name)}`,
        },
      };
      return c.json(response, 201);
    } catch (err: unknown) {
      // The K8s client throws an `ApiException` whose body carries
      // `code` (HTTP status) + `reason` + `message`. Pass-through the
      // status when known, fall back to 500.
      const status = extractK8sStatus(err);
      if (status === 409) {
        const body: CreateTaskErrorBody = {
          error: `AgentTask ${namespace}/${name} already exists`,
        };
        return c.json(body, 409);
      }
      if (status === 404) {
        const body: CreateTaskErrorBody = {
          error: `namespace "${namespace}" not found, or AgentTask CRD not installed`,
        };
        return c.json(body, 404);
      }
      if (status === 403) {
        const body: CreateTaskErrorBody = {
          error: `RBAC denied: workbench-api ServiceAccount cannot create AgentTask in ${namespace}`,
        };
        return c.json(body, 403);
      }
      const body: CreateTaskErrorBody = {
        error: `K8s API call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return c.json(body, 500);
    }
  });

  app.get('/api/tasks/:namespace/:name', (c) => {
    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
    const task = deps.cache.getTask(namespace, name);
    if (task === undefined) {
      return c.json({ error: 'not-found', namespace, name }, 404);
    }
    const agentName = task.spec.targetAgent;
    const agent = agentName !== undefined ? deps.cache.getAgent(namespace, agentName) : undefined;
    const job = deps.cache.findJobForTask(namespace, name);
    const pod = deps.cache.findPodForTask(namespace, name);
    const detail = taskDetail(task, {
      ...(agent !== undefined && { agent }),
      ...(job !== undefined && { job }),
      ...(pod !== undefined && { pod }),
    });
    // Attach a Langfuse trace deep-link when configured. The dto mapper
    // returns null when the task has no UID; surface that as omitted
    // rather than null so the UI can use a simple "key present" check.
    const link =
      deps.langfuseBaseUrl !== undefined
        ? traceLink(task, { provider: 'langfuse', baseUrl: deps.langfuseBaseUrl })
        : null;
    if (link !== null) {
      return c.json({ ...detail, traceLink: link });
    }
    return c.json(detail);
  });

  return app;
}

/**
 * The cache exposes per-namespace Agent reads but no "have I seen any
 * Agent in this namespace yet?" signal. Approximate by listing all
 * agents and checking whether any live in the namespace — if the
 * answer is yes, our cache HAS observed something there and a
 * targetAgent miss is meaningfully a 404. If the answer is no, the
 * informer simply hasn't reached this namespace; the K8s API call is
 * the authoritative gate.
 */
function hasNamespaceLoadedAgents(
  cache: { listAgents?: () => readonly { metadata: { namespace?: string } }[] },
  namespace: string,
): boolean {
  if (typeof cache.listAgents !== 'function') return false;
  const agents = cache.listAgents();
  for (const a of agents) {
    if ((a.metadata.namespace ?? 'default') === namespace) return true;
  }
  return false;
}

/**
 * The K8s client's ApiException carries `body.code` (HTTP status as
 * number) when the API server returned a structured Status. Older
 * thrown shapes used `statusCode`. Try both; return undefined when
 * neither is present so the caller falls back to 500.
 */
function extractK8sStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.body === 'object' && e.body !== null) {
    const b = e.body as Record<string, unknown>;
    if (typeof b.code === 'number') return b.code;
  }
  return undefined;
}

interface CreatedMeta {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly creationTimestamp?: string;
}

/**
 * Pick `metadata.{name,namespace,uid,creationTimestamp}` off the K8s API's
 * untyped `unknown` return without dragging unsafe-`any` chains through
 * the response builder. Returns an empty `{}` if the object is malformed —
 * the caller substitutes the request-supplied values as a fallback.
 */
function readCreatedMeta(obj: unknown): CreatedMeta {
  if (obj === null || typeof obj !== 'object') return {};
  const candidate = (obj as Record<string, unknown>).metadata;
  if (candidate === null || typeof candidate !== 'object') return {};
  const m = candidate as Record<string, unknown>;
  return {
    ...(typeof m.name === 'string' && { name: m.name }),
    ...(typeof m.namespace === 'string' && { namespace: m.namespace }),
    ...(typeof m.uid === 'string' && { uid: m.uid }),
    ...(typeof m.creationTimestamp === 'string' && { creationTimestamp: m.creationTimestamp }),
  };
}

function formatFieldError(e: ValidationError): {
  readonly field: string;
  readonly code: string;
  readonly detail?: string;
} {
  switch (e.code) {
    case 'missing':
      return { field: e.field, code: e.code };
    case 'wrong-type':
      return { field: e.field, code: e.code, detail: `expected ${e.expected}` };
    case 'empty':
      return { field: e.field, code: e.code };
    case 'too-long':
      return { field: e.field, code: e.code, detail: `max=${String(e.max)}` };
    case 'out-of-range':
      return { field: e.field, code: e.code, detail: `range=[${String(e.min)},${String(e.max)}]` };
    case 'invalid-name':
      return { field: e.field, code: e.code };
  }
}

/**
 * Newest-first ISO sort. Undefined timestamps go to the bottom — they
 * usually mean "task was just created and the cache hasn't caught up
 * with creationTimestamp yet" and we don't want them to pin to the top.
 */
function compareIsoDesc(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b.localeCompare(a);
}
