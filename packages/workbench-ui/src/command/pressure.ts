/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * pressure — Phase 2 / CC-04. UI-side classification of nine
 * pressure types from existing CommandSnapshot fields. No new
 * workbench-api endpoint, no new substrate state. Each entry in
 * PRESSURE_TYPES declares its source field(s), classify function,
 * and detail-link computation.
 *
 * See COMMAND-CENTER-CONTRACT.md §6 Pressure Systems for the nine
 * canonical pressure types, and CONTEXT.md D-CC-04-A for the
 * decision to derive all 9 UI-side from snapshot fields.
 *
 * TaskSummary fallback notes (per RESEARCH.md Finding 2):
 *   The "ideal" source for several pressure types lives only on
 *   TaskDetail (pilotEvidence.policy.maxConcurrentChildren,
 *   pilotEvidence.verification.passed, traceLink, etc.). Command
 *   Center is snapshot-only — TaskSummary-only fallbacks are used
 *   for v0.2 with documented promotion paths in each entry's
 *   leading comment.
 */

import type { CommandSnapshot } from './state.js';
import type { TaskSummary } from '../types.js';

export interface PressureMarker {
  readonly kind: PressureType['kind'];
  /** Single source field; mutually exclusive with sourceFields. */
  readonly sourceField?: string;
  /** Multiple source fields when the marker derives from a computed value. */
  readonly sourceFields?: readonly string[];
  /** ns/name of the impacted Agent or Task — used for stable React keys + detail links. */
  readonly affectedKey?: string;
  /** Hash-route deep link (#/tasks/<ns>/<name>, #/gateway, #/cluster). */
  readonly detailLink: string;
  /** Operator-facing label (rendered as anchor textContent). */
  readonly label: string;
}

export interface PressureType {
  readonly kind:
    | 'context'
    | 'gateway'
    | 'policy'
    | 'verifier'
    | 'artifact'
    | 'trace'
    | 'pod'
    | 'quota'
    | 'telemetry';
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly classify: (snapshot: CommandSnapshot) => PressureMarker[];
  readonly detailLink: (marker: PressureMarker) => string;
}

/**
 * Threshold (ms) for the stale-telemetry pressure type. Exposed so
 * tests can verify the boundary, but currently inlined since the
 * classify function is the only consumer.
 */
const STALE_TELEMETRY_MS = 30_000;

/**
 * Build a hash-route deep-link to a task's detail page. Mirrors the
 * encoding in CommandView.tsx (lines 1971/2036) for AgentPanel /
 * TaskPanel "Open detail →" links.
 */
function taskKey(t: { readonly namespace: string; readonly name: string }): string {
  return `#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`;
}

export const PRESSURE_TYPES: readonly PressureType[] = [
  // ─────────────────────────── gateway saturation ───────────────────────────
  // Source fields: GatewayCapacityRow.inFlight + GatewayCapacityRow.currentCap.
  // Fires when inFlight/currentCap >= 0.8 for any gateway row.
  {
    kind: 'gateway',
    sourceFields: ['inFlight', 'currentCap'],
    classify: (s): PressureMarker[] =>
      s.gatewayCapacity
        .filter((row) => row.currentCap > 0 && row.inFlight / row.currentCap >= 0.8)
        .map(
          (row): PressureMarker => ({
            kind: 'gateway',
            sourceFields: ['inFlight', 'currentCap'],
            affectedKey: row.endpoint,
            detailLink: '#/gateway',
            label: `${row.model} — ${String(row.inFlight)}/${String(row.currentCap)} in flight (≥80%)`,
          }),
        ),
    detailLink: (): string => '#/gateway',
  },

  // ─────────────────────────── artifact debt ───────────────────────────
  // Source fields: TaskSummary.artifactCount + TaskSummary.phase. Fires
  // when phase=Completed and (artifactCount ?? 0) === 0.
  {
    kind: 'artifact',
    sourceFields: ['artifactCount', 'phase'],
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter((t) => t.phase === 'Completed' && (t.artifactCount ?? 0) === 0)
        .map(
          (t): PressureMarker => ({
            kind: 'artifact',
            sourceFields: ['artifactCount', 'phase'],
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — completed without artifacts`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── pod failure ───────────────────────────
  // Source fields: TaskSummary.phase + TaskSummary.podName. Fires when
  // phase=Failed and podName is defined.
  {
    kind: 'pod',
    sourceFields: ['phase', 'podName'],
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter((t) => t.phase === 'Failed' && t.podName !== undefined)
        .map(
          (t): PressureMarker => ({
            kind: 'pod',
            sourceFields: ['phase', 'podName'],
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — pod ${t.podName ?? '?'} failed`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── quota wall ───────────────────────────
  // Source field: DispositionOverlayRow.overBudget. Fires for each row
  // with overBudget=true. detailLink resolves to the most-recent
  // terminal task targeting the agent (sorted by completedAt /
  // startedAt / createdAt) — falls back to #/cluster if no such task
  // is found.
  {
    kind: 'quota',
    sourceField: 'overBudget',
    classify: (s): PressureMarker[] => {
      const out: PressureMarker[] = [];
      for (const row of s.dispositions.values()) {
        if (!row.overBudget) continue;
        let bestTask: TaskSummary | undefined;
        let bestMs = -Infinity;
        for (const t of s.tasks.values()) {
          if (t.namespace !== row.namespace) continue;
          if (t.targetAgent !== row.agentName) continue;
          const stamp = t.completedAt ?? t.startedAt ?? t.createdAt ?? '';
          const ms = stamp === '' ? NaN : Date.parse(stamp);
          if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            bestTask = t;
          }
        }
        out.push({
          kind: 'quota',
          sourceField: 'overBudget',
          affectedKey: row.agentRef,
          detailLink: bestTask !== undefined ? taskKey(bestTask) : '#/cluster',
          label: `${row.agentName} — over budget (${row.overBudgetReason ?? 'unspecified'})`,
        });
      }
      return out;
    },
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── stale telemetry ───────────────────────────
  // Source field: CommandSnapshot.lastEventAt. Single global marker —
  // fires when Date.now() − lastEventAt > 30s. The Date.now() reference
  // is the only wallclock dependency in this module; tests stub via
  // vi.useFakeTimers() + vi.setSystemTime() for determinism.
  {
    kind: 'telemetry',
    sourceField: 'lastEventAt',
    classify: (s): PressureMarker[] => {
      const stale = Date.now() - s.lastEventAt;
      if (stale <= STALE_TELEMETRY_MS) return [];
      return [
        {
          kind: 'telemetry',
          sourceField: 'lastEventAt',
          detailLink: '#/cluster',
          label: `SSE stream stale (${String(Math.round(stale / 1000))}s since last event)`,
        },
      ];
    },
    detailLink: (): string => '#/cluster',
  },

  // ─────────────────────────── context pressure ───────────────────────────
  // Ideal source is `pilotEvidence.policy.maxConcurrentChildren` ratio
  // against `pilotEvidence.taskGraph.inFlightCount`, but pilotEvidence
  // lives on TaskDetail, NOT TaskSummary, so the v0.2 heuristic uses
  // TaskSummary.childCount >= 2 while phase=Dispatched. Promote to
  // the ideal source if pilotEvidence is added to TaskSummary in a
  // future phase (per RESEARCH.md Finding 2).
  {
    kind: 'context',
    sourceFields: ['childCount', 'phase'],
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter((t) => t.phase === 'Dispatched' && (t.childCount ?? 0) >= 2)
        .map(
          (t): PressureMarker => ({
            kind: 'context',
            sourceFields: ['childCount', 'phase'],
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — high fanout (${String(t.childCount ?? 0)} children, dispatched)`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── verifier failure ───────────────────────────
  // Ideal source is `pilotEvidence.verification.passed === false` on
  // TaskDetail; v0.2 fallback uses TaskSummary error-string matching
  // for "verifier" (per RESEARCH.md Finding 2). Best-effort heuristic
  // — false positives surface a "verifier failed" marker on a
  // non-verifier failure (acceptable — operator-facing, not
  // exploitable per threat model T-02-05).
  {
    kind: 'verifier',
    sourceFields: ['phase', 'error'],
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter(
          (t) =>
            t.phase === 'Failed' &&
            t.error !== undefined &&
            t.error.toLowerCase().includes('verifier'),
        )
        .map(
          (t): PressureMarker => ({
            kind: 'verifier',
            sourceFields: ['phase', 'error'],
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — verifier failed`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── trace gap ───────────────────────────
  // Ideal source is `traceLink === undefined` on TaskDetail;
  // TaskSummary doesn't carry traceLink (RESEARCH.md Finding 2 +
  // CONTEXT.md). Marker fires on every terminal task with the
  // canonical "trace link unknown — open task detail" label, linking
  // to TaskDetail which carries the real link. Defer adding
  // traceLink to TaskSummary per CONTEXT.md Deferred Ideas.
  {
    kind: 'trace',
    sourceField: 'phase',
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter((t) => t.phase === 'Completed' || t.phase === 'Failed')
        .map(
          (t): PressureMarker => ({
            kind: 'trace',
            sourceField: 'phase',
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — trace link unknown — open task detail`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },

  // ─────────────────────────── policy denial ───────────────────────────
  // Ideal source is a structured audit-event 'policy_denied' kind on
  // the SSE stream, but the current SSE only emits
  // {kind: 'task'|'agent'|'job'|'pod', op, key} (RESEARCH.md Open
  // Question 1). v0.2 fallback uses TaskSummary error-string matching
  // for "policy"; promote to a structured signal in a future phase
  // if a clean audit-event surface lands in workbench-api. Best-
  // effort heuristic — same false-positive accept disposition as
  // verifier (threat model T-02-05).
  {
    kind: 'policy',
    sourceFields: ['phase', 'error'],
    classify: (s): PressureMarker[] =>
      Array.from(s.tasks.values())
        .filter(
          (t) =>
            t.phase === 'Failed' &&
            t.error !== undefined &&
            t.error.toLowerCase().includes('policy'),
        )
        .map(
          (t): PressureMarker => ({
            kind: 'policy',
            sourceFields: ['phase', 'error'],
            affectedKey: `${t.namespace}/${t.name}`,
            detailLink: taskKey(t),
            label: `${t.name} — policy denial`,
          }),
        ),
    detailLink: (m): string => m.detailLink,
  },
];

/**
 * Derived from PRESSURE_TYPES['kind'] so the closed-enum stays in
 * one place. Now resolves to the union of all nine kind literals
 * automatically because PRESSURE_TYPES is populated.
 */
export type PressureFieldName = PressureType['kind'];
