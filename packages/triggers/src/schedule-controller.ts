/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * KagentSchedule controller — the cron half of Wave 0 entry points.
 *
 * Responsibilities:
 *   1. Hold an in-memory cache of `KagentSchedule` CRs (the operator's
 *      informer feeds this via `upsert(...)` / `remove(...)`).
 *   2. Tick once a minute on the wall clock; for each non-suspended
 *      schedule whose parsed cron matches the current minute, render
 *      an AgentTask and hand it to `deps.createAgentTask`.
 *   3. Patch the schedule's status (`lastTickAt` + recomputed
 *      `nextTickAt`) via `deps.patchScheduleStatus`.
 *
 * Why a custom tick loop instead of `node-cron` (or per-schedule
 * `setTimeout`s):
 *   - Pinning every schedule to the same wall-clock minute boundary
 *     keeps observability simple — the operator's logs show exactly
 *     one "tick" line per minute regardless of fan-out.
 *   - Per-schedule timers leak across schedule replacements; the
 *     in-memory cache approach resyncs naturally when the informer
 *     fires update/delete.
 *   - We don't need sub-minute granularity at v0.1 (cron is 5-field).
 *
 * Failure handling: if `createAgentTask` throws for one schedule we log
 * + emit (status patch reflects last successful tick); other schedules
 * are unaffected. If the status patch fails we log and move on — the
 * tick already produced its AgentTask, which is the load-bearing
 * effect.
 */

import { cronMatches, nextTickAfter, parseCron, type ParsedSchedule } from './cron.js';
import {
  renderAgentTaskFromTemplate,
  type AgentTaskTemplateSpec,
  type RenderedAgentTask,
} from './render-task.js';

/** Shape of the `KagentSchedule` CR fields the controller cares about. */
export interface KagentScheduleResource {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid?: string;
  };
  readonly spec: {
    readonly schedule: string;
    readonly suspend?: boolean;
    readonly taskTemplate: AgentTaskTemplateSpec;
  };
}

export interface ScheduleStatusPatch {
  readonly lastTickAt?: string;
  readonly nextTickAt?: string;
}

export interface ScheduleControllerDeps {
  /** Factory that creates the rendered AgentTask in K8s. */
  readonly createAgentTask: (manifest: RenderedAgentTask) => Promise<void> | void;
  /** PATCH `KagentSchedule.status` (server-side merge). */
  readonly patchScheduleStatus: (
    namespace: string,
    name: string,
    patch: ScheduleStatusPatch,
  ) => Promise<void> | void;
  /**
   * Test-injectable clock. Production calls `() => new Date()`. The
   * controller pins every tick to the top of the minute (seconds = 0,
   * ms = 0) so an early/late wake doesn't double-fire a schedule.
   */
  readonly clock?: () => Date;
}

interface CachedSchedule {
  readonly resource: KagentScheduleResource;
  readonly parsed: ParsedSchedule;
  readonly parseError?: string;
}

/**
 * Build a controller. Use `start()` / `stop()` for the wall-clock loop;
 * tests prefer `tickOnce(now)` which is deterministic.
 */
export function buildScheduleController(deps: ScheduleControllerDeps) {
  const cache = new Map<string, CachedSchedule>();
  let timer: NodeJS.Timeout | undefined;
  const clock = deps.clock ?? ((): Date => new Date());

  const cacheKey = (ns: string, name: string): string => `${ns}/${name}`;

  function upsert(resource: KagentScheduleResource): void {
    const key = cacheKey(resource.metadata.namespace, resource.metadata.name);
    try {
      const parsed = parseCron(resource.spec.schedule);
      cache.set(key, { resource, parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cache.set(key, {
        resource,
        // unreachable cron (no minutes match) so the controller will
        // never tick this schedule until upsert sees a fixed expression.
        parsed: {
          minute: new Set(),
          hour: new Set(),
          dom: new Set(),
          month: new Set(),
          dow: new Set(),
          domAny: false,
          dowAny: false,
        },
        parseError: msg,
      });
    }
  }

  function remove(namespace: string, name: string): void {
    cache.delete(cacheKey(namespace, name));
  }

  /**
   * Run one tick at exactly `now` (truncated to top-of-minute). For
   * each cached schedule whose parsed cron matches:
   *   1. render an AgentTask via `renderAgentTaskFromTemplate`
   *   2. hand it to `createAgentTask`
   *   3. patch status with `{lastTickAt: now, nextTickAt: <computed>}`
   *
   * Returns the count of successfully-created AgentTasks.
   */
  async function tickOnce(now?: Date): Promise<number> {
    const at = topOfMinute(now ?? clock());
    let created = 0;
    for (const { resource, parsed, parseError } of cache.values()) {
      if (parseError !== undefined) {
        console.warn(
          `[kagent-triggers] schedule ${resource.metadata.namespace}/${resource.metadata.name} ` +
            `has unparseable cron '${resource.spec.schedule}': ${parseError}`,
        );
        continue;
      }
      if (resource.spec.suspend === true) continue;
      if (!cronMatches(parsed, at)) continue;
      try {
        const manifest = renderAgentTaskFromTemplate({
          triggerName: resource.metadata.name,
          triggerKind: 'schedule',
          namespace: resource.metadata.namespace,
          taskTemplate: resource.spec.taskTemplate,
          now: at,
        });
        await deps.createAgentTask(manifest);
        created += 1;
      } catch (err) {
        console.error(
          `[kagent-triggers] failed to create AgentTask for schedule ` +
            `${resource.metadata.namespace}/${resource.metadata.name}:`,
          err,
        );
        // Skip status patch — keep `lastTickAt` pointing at the last
        // tick that DID succeed so an alert/oncall sees the gap.
        continue;
      }
      const next = nextTickAfter(parsed, at);
      const patch: ScheduleStatusPatch = {
        lastTickAt: at.toISOString(),
        ...(next !== undefined && { nextTickAt: next.toISOString() }),
      };
      try {
        await deps.patchScheduleStatus(resource.metadata.namespace, resource.metadata.name, patch);
      } catch (err) {
        console.error(
          `[kagent-triggers] failed to patch status on schedule ` +
            `${resource.metadata.namespace}/${resource.metadata.name}:`,
          err,
        );
      }
    }
    return created;
  }

  function start(): void {
    if (timer !== undefined) return;
    // Schedule the first tick on the next minute boundary so we
    // don't fire mid-minute on a server start that happens at
    // :30s. setInterval thereafter keeps minute alignment for the
    // process's lifetime (drift across days is negligible compared to
    // the 60s tick window).
    const now = clock();
    const msUntilNextMinute = 60_000 - (now.getTime() % 60_000);
    timer = setTimeout(() => {
      void runTick();
      timer = setInterval(() => {
        void runTick();
      }, 60_000);
    }, msUntilNextMinute);
  }

  async function runTick(): Promise<void> {
    try {
      await tickOnce();
    } catch (err) {
      console.error('[kagent-triggers] tick loop error:', err);
    }
  }

  function stop(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = undefined;
    }
  }

  function size(): number {
    return cache.size;
  }

  return {
    upsert,
    remove,
    tickOnce,
    start,
    stop,
    size,
  };
}

export type ScheduleController = ReturnType<typeof buildScheduleController>;

function topOfMinute(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      0,
      0,
    ),
  );
}
