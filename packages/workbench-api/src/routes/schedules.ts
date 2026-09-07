/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `GET /api/schedules` — read-only projection of `KagentSchedule` CRs.
 *
 * Cron triggers that materialize a fresh AgentTask per tick (see
 * `packages/operator/src/crds/kagent-schedule.ts`). Serves from the
 * same in-memory `SnapshotCache` the agents/tasks routes use — the
 * informer wired in `informer.ts` keeps it fresh.
 */

import { Hono } from 'hono';

import type { KagentSchedule } from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

export interface SchedulesRouteDeps {
  readonly cache: SnapshotCache;
}

export interface ScheduleSummary {
  readonly namespace: string;
  readonly name: string;
  readonly schedule: string;
  readonly suspended: boolean;
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly lastTickAt?: string;
  readonly nextTickAt?: string;
}

function scheduleSummary(s: KagentSchedule): ScheduleSummary {
  return {
    namespace: s.metadata.namespace ?? 'default',
    name: s.metadata.name ?? '<unnamed>',
    schedule: s.spec.schedule,
    suspended: s.spec.suspend === true,
    ...(s.spec.taskTemplate.targetAgent !== undefined && {
      targetAgent: s.spec.taskTemplate.targetAgent,
    }),
    ...(s.spec.taskTemplate.targetCapability !== undefined && {
      targetCapability: s.spec.taskTemplate.targetCapability,
    }),
    ...(s.status?.lastTickAt !== undefined && { lastTickAt: s.status.lastTickAt }),
    ...(s.status?.nextTickAt !== undefined && { nextTickAt: s.status.nextTickAt }),
  };
}

export function schedulesRoute(deps: SchedulesRouteDeps): Hono {
  const app = new Hono();

  app.get('/api/schedules', (c) => {
    const url = new URL(c.req.url);
    const ns = url.searchParams.get('namespace') ?? undefined;

    const items: ScheduleSummary[] = deps.cache
      .listSchedules()
      .filter((s) => ns === undefined || (s.metadata.namespace ?? 'default') === ns)
      .map(scheduleSummary)
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

    return c.json({ items });
  });

  return app;
}
