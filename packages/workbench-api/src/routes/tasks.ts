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
 */

import { Hono } from 'hono';

import { taskDetail, taskSummary, type TaskSummary } from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

export interface TasksRouteDeps {
  readonly cache: SnapshotCache;
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
    return c.json(detail);
  });

  return app;
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
