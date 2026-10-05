/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { CoreV1Api } from '@kubernetes/client-node';
import type { SnapshotCache } from '../cache.js';
import type { TaskTraceReader } from '../langfuse-client.js';
import { scrubDiagnostic } from '../diagnostic-data.js';

export interface TaskDiagnosticsDeps {
  readonly cache: SnapshotCache;
  readonly traceReader?: TaskTraceReader;
  readonly coreApi?: CoreV1Api;
  /**
   * When set, only tasks whose targetAgent starts with one of these prefixes are
   * served (WORKBENCH_DIAGNOSTICS_AGENT_PREFIXES). A task's diagnostics carry its
   * model inputs, so agents given this read must not reach operator conversations.
   */
  readonly agentPrefixes?: readonly string[];
}
/** Task identity is the read boundary; callers cannot choose arbitrary trace IDs or pod names. */
export function taskDiagnosticsRoute(deps: TaskDiagnosticsDeps): Hono {
  const app = new Hono();
  app.get('/api/tasks/:namespace/:name/diagnostics', async (c) => {
    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
    const task = deps.cache.getTask(namespace, name);
    if (task === undefined) return c.json({ error: 'not-found' }, 404);
    const prefixes = deps.agentPrefixes ?? [];
    const agent = task.spec.targetAgent ?? '';
    // Out of scope looks exactly like absent: the reader learns nothing about other tasks.
    if (prefixes.length > 0 && !prefixes.some((prefix) => agent.startsWith(prefix))) {
      return c.json({ error: 'not-found' }, 404);
    }
    // Fleet HTTP tools interpolate absent optional args as empty query
    // values (`?afterSequence=&limit=…`); treat '' as "not supplied".
    const rawAfter = c.req.query('afterSequence');
    const rawLimit = c.req.query('limit');
    const afterSequence = Number(rawAfter === undefined || rawAfter === '' ? '-1' : rawAfter);
    const limit = Number(rawLimit === undefined || rawLimit === '' ? '20' : rawLimit);
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < -1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return c.json(
        { error: 'invalid-pagination', limit: '1..100', afterSequence: 'integer >= -1' },
        400,
      );
    }
    const uid = task.metadata.uid;
    if (uid === undefined) return c.json({ error: 'task-identity-unavailable' }, 503);
    const parent = task.spec.runConfig?.traceparent?.match(
      /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/,
    )?.[1];
    const traceId = parent ?? createHash('sha256').update(uid).digest('hex').slice(0, 32);
    const trace =
      deps.traceReader !== undefined
        ? await deps.traceReader.read({ traceId, runId: uid, afterSequence, limit })
        : {
            state: 'unavailable',
            source: 'langfuse',
            reason: 'trace-reader-disabled',
            events: [],
            nextSequence: afterSequence,
            hasMore: false,
          };
    const pod = deps.cache.findPodForTask(namespace, name);
    const logs: { container: string; previous: boolean; state: string; text?: unknown }[] = [];
    if (pod?.metadata?.name !== undefined && deps.coreApi !== undefined) {
      for (const container of (pod.spec?.containers ?? []).slice(0, 4)) {
        for (const previous of [
          false,
          ...((pod.status?.containerStatuses ?? []).some(
            (s) => s.name === container.name && s.restartCount > 0,
          )
            ? [true]
            : []),
        ]) {
          try {
            const text = await deps.coreApi.readNamespacedPodLog({
              namespace,
              name: pod.metadata.name,
              container: container.name,
              previous,
              tailLines: 200,
              limitBytes: 65_536,
              timestamps: true,
            });
            logs.push({
              container: container.name,
              previous,
              state: 'observed',
              text: scrubDiagnostic(text),
            });
          } catch {
            logs.push({ container: container.name, previous, state: 'unavailable' });
          }
        }
      }
    }
    return c.json({
      schema: 'kagent-task-diagnostics/v1',
      task: scrubDiagnostic({
        namespace,
        name,
        uid,
        targetAgent: task.spec.targetAgent,
        runConfig: task.spec.runConfig,
        phase: task.status?.phase,
        error: task.status?.error,
        children: task.status?.children ?? [],
        artifacts: task.status?.artifacts ?? [],
      }),
      trace: { ...trace, traceId },
      pod:
        pod === undefined
          ? { state: 'gone', logs }
          : {
              state: 'observed',
              name: pod.metadata?.name,
              phase: pod.status?.phase,
              conditions: scrubDiagnostic(pod.status?.conditions ?? []),
              containers: scrubDiagnostic(pod.status?.containerStatuses ?? []),
              logs,
            },
    });
  });
  return app;
}
