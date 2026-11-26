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
 *   4. Run a tick the loop never evaluated. A schedule without an idle
 *      gate whose recorded `nextTickAt` has passed (the schedule was
 *      suspended, the operator was down, or task creation failed) fires
 *      once at the next tick, however many ticks it missed.
 *   5. Run on request: the `RUN_REQUESTED_ANNOTATION` instant, when it is
 *      newer than `lastTickAt`, fires the schedule once outside its cron
 *      and its idle gate. A suspended schedule runs neither way.
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

import type { NamespaceIdleAssessment } from './idle.js';
import { cronMatches, nextTickAfter, parseCron, type ParsedSchedule } from './cron.js';
import {
  renderAgentTaskFromTemplate,
  type AgentTaskTemplateSpec,
  type RenderedAgentTask,
} from './render-task.js';

/**
 * "Run this schedule now": an RFC 3339 instant written by the Workbench
 * (`POST /api/schedules/:ns/:name/run`). The controller honours it at the
 * first tick at or after that instant and records the run in
 * `status.lastTickAt`, which is what makes a request fire once.
 */
export const RUN_REQUESTED_ANNOTATION = 'kagent.knuteson.io/run-requested-at';

/** createAgentTask throws this when a schedule has no work to bind right now; the tick is skipped quietly. */
export class NoWorkThisTick extends Error {}

/** Shape of the `KagentSchedule` CR fields the controller cares about. */
export interface KagentScheduleResource {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid?: string;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly spec: {
    readonly schedule: string;
    readonly suspend?: boolean;
    /** Idle gate — see `KagentScheduleSpec.whenIdle` in the operator mirror. */
    readonly whenIdle?: {
      readonly quietSeconds?: number;
      readonly minGapSeconds?: number;
    };
    readonly taskTemplate: AgentTaskTemplateSpec;
  };
  readonly status?: {
    readonly lastTickAt?: string;
    readonly nextTickAt?: string;
  };
}

export interface ScheduleStatusPatch {
  readonly lastTickAt?: string;
  readonly nextTickAt?: string;
}

export const DEFAULT_QUIET_SECONDS = 300;

export interface ScheduleControllerDeps {
  /** Factory that creates the rendered AgentTask in K8s. */
  readonly createAgentTask: (manifest: RenderedAgentTask) => Promise<void> | void;
  /**
   * For `whenIdle` schedules: the namespace's idle state (idle.ts):
   * `idleSince` is undefined while a live task waits for admission, and
   * `activeSchedules` names schedules whose own task is still live.
   * Omitted = every namespace is treated as busy, so `whenIdle` schedules
   * never fire (fail closed).
   */
  readonly assessIdle?: (
    namespace: string,
  ) => Promise<Pick<NamespaceIdleAssessment, 'idleSince' | 'activeSchedules'>>;
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
      const requested = runRequested(resource, at);
      if (!cronMatches(parsed, at) && !requested && !tickMissed(resource, parsed, at)) {
        // A spec change can leave nextTickAt from the previous expression
        // until the new cron first fires. Refresh only when that timestamp
        // cannot be a tick of the current cron; preserve valid overdue ticks
        // so a failed task creation remains visible.
        const recorded = resource.status?.nextTickAt;
        if (recorded !== undefined) {
          const recordedAt = new Date(recorded);
          if (!Number.isFinite(recordedAt.getTime()) || !cronMatches(parsed, recordedAt)) {
            const next = nextTickAfter(parsed, at);
            if (next !== undefined) {
              try {
                await deps.patchScheduleStatus(
                  resource.metadata.namespace,
                  resource.metadata.name,
                  { nextTickAt: next.toISOString() },
                );
              } catch (err) {
                console.error(
                  `[kagent-triggers] failed to refresh next tick on schedule ` +
                    `${resource.metadata.namespace}/${resource.metadata.name}:`,
                  err,
                );
              }
            }
          }
        }
        continue;
      }
      if (resource.spec.whenIdle !== undefined && !requested) {
        const gate = await idleGateOpen(resource, at);
        if (!gate) continue;
      }
      let bound = true;
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
        // Nothing to bind this tick: not a failure. The schedule still looked, so its next tick is
        // recorded; without it a request-only schedule read as never armed (2026-11-20, forum 11528).
        if (err instanceof NoWorkThisTick) bound = false;
        else {
          console.error(
            `[kagent-triggers] failed to create AgentTask for schedule ` +
              `${resource.metadata.namespace}/${resource.metadata.name}:`,
            err,
          );
          // Skip status patch — keep `lastTickAt` pointing at the last
          // tick that DID succeed so an alert/oncall sees the gap.
          continue;
        }
      }
      const next = nextTickAfter(parsed, at);
      const patch: ScheduleStatusPatch = {
        ...(bound && { lastTickAt: at.toISOString() }),
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

  /**
   * `whenIdle`: the namespace must have been idle for `quietSeconds`
   * (nothing Pending/Dispatched, and the last task finished that long
   * ago) and this schedule's previous task must be `minGapSeconds` old.
   * The previous-task instant comes from `status.lastTickAt`, which the
   * informer keeps current, so a restart does not forget the gap.
   */
  async function idleGateOpen(resource: KagentScheduleResource, at: Date): Promise<boolean> {
    if (deps.assessIdle === undefined) return false;
    const quietMs = (resource.spec.whenIdle?.quietSeconds ?? DEFAULT_QUIET_SECONDS) * 1000;
    const gapMs = (resource.spec.whenIdle?.minGapSeconds ?? 0) * 1000;
    const last = resource.status?.lastTickAt;
    if (last !== undefined && at.getTime() - Date.parse(last) < gapMs) return false;
    let idleSince: Date | undefined;
    try {
      const idle = await deps.assessIdle(resource.metadata.namespace);
      // This schedule's own previous task is still live: never a second copy.
      if (idle.activeSchedules.has(resource.metadata.name)) return false;
      idleSince = idle.idleSince;
    } catch (err) {
      console.error(
        `[kagent-triggers] idle check failed for schedule ` +
          `${resource.metadata.namespace}/${resource.metadata.name}:`,
        err,
      );
      return false;
    }
    return idleSince !== undefined && at.getTime() - idleSince.getTime() >= quietMs;
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

/** A run request is live from its own instant until a tick at or after it is recorded. */
function runRequested(resource: KagentScheduleResource, at: Date): boolean {
  const requestedAt = Date.parse(resource.metadata.annotations?.[RUN_REQUESTED_ANNOTATION] ?? '');
  if (!Number.isFinite(requestedAt) || requestedAt > at.getTime()) return false;
  const last = Date.parse(resource.status?.lastTickAt ?? '');
  return !Number.isFinite(last) || requestedAt > last;
}

/**
 * The recorded next tick is a tick of the current cron and it has passed
 * without being run. Idle-gated schedules are left out: a closed gate
 * leaves their `nextTickAt` behind on purpose, and they look again at
 * their next cron minute.
 */
function tickMissed(resource: KagentScheduleResource, parsed: ParsedSchedule, at: Date): boolean {
  if (resource.spec.whenIdle !== undefined) return false;
  const recorded = new Date(resource.status?.nextTickAt ?? '');
  return (
    Number.isFinite(recorded.getTime()) &&
    recorded.getTime() < at.getTime() &&
    cronMatches(parsed, recorded)
  );
}

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
