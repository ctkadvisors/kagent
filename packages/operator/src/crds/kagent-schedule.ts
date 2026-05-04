/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * KagentSchedule — Wave 0 entry-point CRD that materializes a fresh
 * AgentTask per cron tick. The operator-side controller (in
 * `@kagent/triggers`) parses `spec.schedule`, ticks once a minute, and
 * creates an AgentTask whose body is `spec.taskTemplate` with
 * trigger-stamping labels + the Wave 0 placeholder-cap annotation.
 *
 * This type mirrors the YAML CRD schema at
 * `packages/operator/manifests/crds/kagent-schedules.yaml` (and the
 * chart-shipped copy at
 * `packages/operator/charts/kagent-operator/crds/kagent-schedules.yaml`).
 * Keep both in sync — schema drift is caught by
 * `pnpm --filter @kagent/operator crd:check`.
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §3.3 (AgentWorkflow triggers — schedule is
 *     the foundation; v0.1.16 ships the schedule-only entry, v0.3.2
 *     wires AgentWorkflow on top of it)
 *   - docs/WAVES.md §2.6 sub-team Entry deliverables 1-2
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import { API_GROUP_VERSION, type AgentTaskSpec } from './types.js';

/**
 * Spec body of `KagentSchedule.spec.taskTemplate`. Structurally
 * identical to `AgentTaskSpec` — kept aliased rather than re-exported
 * so the controller can (in v0.2+) layer additional template-only
 * fields (e.g. `idempotencyKeyPrefix`) without leaking them onto the
 * AgentTask wire surface.
 */
export type KagentScheduleTaskTemplate = AgentTaskSpec;

export interface KagentScheduleSpec {
  /**
   * 5-field cron expression evaluated in UTC. The controller (in
   * `@kagent/triggers/cron.ts`) supports wildcards, comma-lists,
   * ranges, and step values; it does NOT support cron macros
   * (`@daily`, `@hourly`), seconds, or the `?` / `L` / `W` / `#`
   * extensions. The CRD's openAPIV3Schema also pins the field to a
   * non-empty string; the controller surfaces parse failures via
   * status.
   */
  readonly schedule: string;

  /**
   * Pause the schedule without deleting the CR. The controller skips
   * cached schedules whose `suspend === true` even when the cron
   * matches the current minute. Default `false`.
   */
  readonly suspend?: boolean;

  /**
   * The AgentTask body the controller materializes per tick. Validated
   * by admission against the same shape as `AgentTask.spec`; mutually-
   * exclusive `targetAgent` / `targetCapability` rule applies here too.
   */
  readonly taskTemplate: KagentScheduleTaskTemplate;
}

export interface KagentScheduleStatus {
  /** RFC 3339 timestamp the controller last successfully ticked. */
  readonly lastTickAt?: string;
  /**
   * RFC 3339 timestamp of the next minute boundary the parsed cron
   * matches. Recomputed after every tick; absent if the schedule was
   * never ticked or the cron is unparseable.
   */
  readonly nextTickAt?: string;
  /** Append-only condition log; mirror of AgentTask's pattern. */
  readonly conditions?: ReadonlyArray<{
    readonly type: string;
    readonly status: 'True' | 'False' | 'Unknown';
    readonly reason?: string;
    readonly message?: string;
    readonly lastTransitionTime: string;
  }>;
}

export interface KagentSchedule {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'KagentSchedule';
  readonly metadata: V1ObjectMeta;
  readonly spec: KagentScheduleSpec;
  readonly status?: KagentScheduleStatus;
}

/**
 * Runtime-checkable type guard. The watch handler hands back unknown-
 * typed CR objects; this narrows by apiVersion + kind + the two
 * required spec fields (`schedule`, `taskTemplate`).
 */
export function isKagentSchedule(obj: unknown): obj is KagentSchedule {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'KagentSchedule') return false;
  const spec = o.spec as { schedule?: unknown; taskTemplate?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (typeof spec.schedule !== 'string' || spec.schedule.length === 0) return false;
  if (typeof spec.taskTemplate !== 'object' || spec.taskTemplate === null) return false;
  return true;
}
