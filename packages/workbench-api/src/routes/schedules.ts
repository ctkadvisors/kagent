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
 *
 * `POST /api/schedules/:namespace/:name/run` — run a schedule now. It only
 * stamps the run-request annotation; the operator's schedule controller
 * creates the task at its next minute tick, through the same path as a
 * cron tick (so fleet work is bound the same way), and records the run in
 * `status.lastTickAt`. A suspended schedule is refused: paused means
 * nothing new starts.
 */

import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';
import { Hono } from 'hono';

import type { KagentSchedule } from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const SCHEDULE_PLURAL = 'kagentschedules';
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');
/** Must equal `RUN_REQUESTED_ANNOTATION` in `@kagent/triggers` schedule-controller.ts. */
export const RUN_REQUESTED_ANNOTATION = 'kagent.knuteson.io/run-requested-at';

export interface SchedulesRouteDeps {
  readonly cache: SnapshotCache;
  /** Write-side client; absent or `writesEnabled !== true` → the run route answers 503. */
  readonly customApi?: CustomObjectsApi;
  readonly writesEnabled?: boolean;
  /** When set, runs are limited to schedules in this namespace. */
  readonly defaultNamespace?: string;
  readonly now?: () => Date;
}

export interface ScheduleSummary {
  readonly namespace: string;
  readonly name: string;
  readonly schedule: string;
  readonly suspended: boolean;
  /** The schedule has an idle gate: it fires at a cron minute only when the namespace is quiet. */
  readonly whenIdle: boolean;
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
    whenIdle: s.spec.whenIdle !== undefined,
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

  app.post('/api/schedules/:namespace/:name/run', async (c) => {
    if (deps.customApi === undefined || deps.writesEnabled !== true) {
      return c.json({ error: 'write surface disabled; set actions.create=true on the chart' }, 503);
    }
    // A JSON content type forces a CORS preflight, so another site's page cannot post this.
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported-media-type', message: 'send application/json' }, 415);
    }
    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
    if (
      typeof deps.defaultNamespace === 'string' &&
      deps.defaultNamespace.length > 0 &&
      namespace !== deps.defaultNamespace
    ) {
      return c.json(
        {
          error: 'namespace-not-permitted',
          message: `runs are limited to the workbench's release namespace (${deps.defaultNamespace}); requested ${namespace}`,
        },
        403,
      );
    }
    const schedule = deps.cache
      .listSchedules()
      .find((s) => (s.metadata.namespace ?? 'default') === namespace && s.metadata.name === name);
    if (schedule === undefined) return c.json({ error: 'not-found', namespace, name }, 404);
    if (schedule.spec.suspend === true) {
      return c.json(
        { error: 'suspended', message: 'a suspended schedule starts nothing; resume it first' },
        409,
      );
    }
    const requestedAt = (deps.now ?? ((): Date => new Date()))().toISOString();
    try {
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: SCHEDULE_PLURAL,
          name,
          body: { metadata: { annotations: { [RUN_REQUESTED_ANNOTATION]: requestedAt } } },
        },
        MERGE_PATCH_OPTIONS,
      );
      return c.json({ ok: true, namespace, name, requestedAt }, 202);
    } catch (err) {
      const e = err as { code?: unknown; statusCode?: unknown };
      const status =
        typeof e.code === 'number'
          ? e.code
          : typeof e.statusCode === 'number'
            ? e.statusCode
            : undefined;
      if (status === 403) {
        return c.json(
          {
            error: `RBAC denied: workbench-api ServiceAccount cannot patch KagentSchedule in ${namespace}`,
          },
          403,
        );
      }
      if (status === 404) return c.json({ error: 'not-found', namespace, name }, 404);
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[workbench-api] run schedule ${namespace}/${name} failed: ${detail}`);
      return c.json({ error: 'patch-failed', message: detail }, 500);
    }
  });

  return app;
}
