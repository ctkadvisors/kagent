/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `GET /api/agents` — the Agent catalog view.
 *
 * Each agent summary carries `recentTaskCounts` derived from the cached
 * AgentTasks. The DTO mapper does the counting; this route just hands
 * it the snapshot.
 */

import { Hono } from 'hono';

import { agentSummary, type AgentSummary } from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

export interface AgentsRouteDeps {
  readonly cache: SnapshotCache;
}

export function agentsRoute(deps: AgentsRouteDeps): Hono {
  const app = new Hono();

  app.get('/api/agents', (c) => {
    const url = new URL(c.req.url);
    const ns = url.searchParams.get('namespace') ?? undefined;
    const tasks = deps.cache.listTasks();

    const summaries: AgentSummary[] = deps.cache
      .listAgents()
      .filter((a) => ns === undefined || (a.metadata.namespace ?? 'default') === ns)
      .map((a) => agentSummary(a, { tasks }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ items: summaries });
  });

  return app;
}
