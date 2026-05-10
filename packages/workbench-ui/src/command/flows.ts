/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * flows — Phase 3 / FLOW-01. UI-side derivation of eight resource
 * flow gauges from existing CommandSnapshot fields. No new
 * workbench-api endpoint, no new substrate state. Each entry in
 * FLOW_TYPES declares its source field(s), compute function, and
 * detail-link computation.
 *
 * See intel/constraints.md §C-flow-economy for the canonical eight
 * flow definitions, COMMAND-CENTER-CONTRACT.md §7 Slice E for the
 * binding "legend in developer docs, NOT in main UI chrome"
 * constraint, and CONTEXT.md D-01-A for the decision to ship as a
 * sibling overlay to PressureOverlay (NOT a replacement).
 *
 * v0.2 fallback notes (per RESEARCH.md Finding 10):
 *   Five of the eight flows (tokenFlow, buildPower, podCapacity,
 *   authority, trust) have an "ideal" source on TaskDetail or
 *   ClusterSnapshot that does not reach useCommandSnapshot() today.
 *   Each entry's leading comment names the ideal source + promotion
 *   phase, mirroring pressure.ts:201–310.
 */

import type { CommandSnapshot } from './state.js';

export interface FlowGauge {
  readonly kind: FlowType['kind'];
  /** Single source field; mutually exclusive with sourceFields. */
  readonly sourceField?: string;
  /** Multiple source fields when the gauge derives from a computed value. */
  readonly sourceFields?: readonly string[];
  /** ns/name/endpoint for per-instance gauges — used for stable React keys + detail links. */
  readonly affectedKey?: string;
  /** Hash-route deep link (#/gateway, #/cluster, #/tasks). */
  readonly detailLink: string;
  /** Operator-facing readout label. */
  readonly label: string;
  /** Gauge numerator (e.g., inFlight, completed count). */
  readonly value: number;
  /** Gauge denominator — undefined for rates/counts without a hard cap. */
  readonly capacity?: number;
  /** Axis label / readout unit ('in flight', 'tasks', 'pods', 'denials', 'events', 'items', 'artifacts'). */
  readonly unit?: string;
}

export interface FlowType {
  readonly kind:
    | 'modelPower'
    | 'tokenFlow'
    | 'buildPower'
    | 'podCapacity'
    | 'artifactBandwidth'
    | 'authority'
    | 'trust'
    | 'attention';
  readonly granularity: 'perEndpoint' | 'perModelClass' | 'perAgent' | 'perNode' | 'substrateWide';
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly compute: (snapshot: CommandSnapshot) => readonly FlowGauge[];
  readonly detailLink: (gauge: FlowGauge) => string;
}

export const FLOW_TYPES: readonly FlowType[] = [
  // ─────────────────────────── modelPower ───────────────────────────
  // Source fields: GatewayCapacityRow.inFlight + GatewayCapacityRow.currentCap.
  // One gauge per gateway endpoint. Clean source — no v0.2 fallback needed.
  // Gauge: value=inFlight, capacity=currentCap (when > 0), unit='in flight'.
  {
    kind: 'modelPower',
    granularity: 'perEndpoint',
    sourceFields: ['inFlight', 'currentCap'],
    compute: (s): readonly FlowGauge[] =>
      s.gatewayCapacity.map((row): FlowGauge => {
        const cap = row.currentCap > 0 ? row.currentCap : undefined;
        return {
          kind: 'modelPower',
          sourceFields: ['inFlight', 'currentCap'],
          affectedKey: row.endpoint,
          detailLink: '#/gateway',
          label: row.model,
          value: row.inFlight,
          ...(cap !== undefined ? { capacity: cap } : {}),
          unit: 'in flight',
        };
      }),
    detailLink: (): string => '#/gateway',
  },

  // ─────────────────────────── tokenFlow ───────────────────────────
  // Ideal source: GatewayUsageRow.inputTokens+outputTokens via /api/gateway/usage
  // rolling window. v0.2 fallback: count of TaskSummary by model in phase=Dispatched.
  // Promote when /api/gateway/usage rows land on useCommandSnapshot() and the
  // task-count proxy is repeatedly insufficient.
  // Note: snapshot.gatewayUsage IS reachable today via useCommandSnapshot()
  // (state.ts:88) — promotion to real per-request token counts is a single-PR
  // future change to compute() body without snapshot-shape change. v0.2 ships
  // task-count proxy per CONTEXT.md D-02-tokenFlow for honesty about scope.
  {
    kind: 'tokenFlow',
    granularity: 'perModelClass',
    sourceFields: ['model', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      // Group Dispatched tasks by model class
      const counts = new Map<string, number>();
      for (const t of s.tasks.values()) {
        if (t.phase !== 'Dispatched' || t.model === undefined) continue;
        counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(
        ([model, count]): FlowGauge => ({
          kind: 'tokenFlow',
          sourceFields: ['model', 'phase'],
          affectedKey: model,
          detailLink: '#/gateway',
          label: `tasks dispatched per model: ${model}`,
          value: count,
          unit: 'tasks',
        }),
      );
    },
    detailLink: (): string => '#/gateway',
  },

  // ─────────────────────────── buildPower ───────────────────────────
  // Ideal capacity: pilotEvidence.policy.maxConcurrentChildren on TaskDetail.
  // v0.2: open-ended per-agent count of Dispatched tasks, no capacity bar.
  // Promote when pilotEvidence reaches TaskSummary in a future phase.
  // Granularity: per agent (one gauge per AgentSummaryRow with active tasks).
  {
    kind: 'buildPower',
    granularity: 'perAgent',
    sourceFields: ['targetAgent', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      const out: FlowGauge[] = [];
      for (const agent of s.agents.values()) {
        let count = 0;
        for (const t of s.tasks.values()) {
          if (t.targetAgent === agent.name && t.phase === 'Dispatched') {
            count++;
          }
        }
        if (count === 0) continue; // skip idle agents
        out.push({
          kind: 'buildPower',
          sourceFields: ['targetAgent', 'phase'],
          affectedKey: `${agent.namespace}/${agent.name}`,
          detailLink: `#/tasks?agent=${agent.name}`,
          label: `${agent.name} — ${String(count)} in flight`,
          value: count,
          unit: 'in flight',
        });
      }
      return out;
    },
    detailLink: (g): string => g.detailLink,
  },

  // ─────────────────────────── podCapacity ───────────────────────────
  // Ideal source: ClusterNodeRow.managedPodCount / ClusterNodeRow.capacity['pods']
  // via /api/cluster/snapshot. v0.2: substrate-wide active-pod count, no capacity bar.
  // Promote when cluster snapshot joins useCommandSnapshot() in a future phase.
  {
    kind: 'podCapacity',
    granularity: 'substrateWide',
    sourceFields: ['podName', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      let count = 0;
      for (const t of s.tasks.values()) {
        if (t.podName !== undefined && (t.phase === 'Dispatched' || t.phase === 'Pending')) {
          count++;
        }
      }
      if (count === 0) return [];
      return [
        {
          kind: 'podCapacity',
          sourceFields: ['podName', 'phase'],
          detailLink: '#/cluster',
          label: 'active pods',
          value: count,
          unit: 'pods',
        },
      ];
    },
    detailLink: (): string => '#/cluster',
  },

  // ─────────────────────────── artifactBandwidth ───────────────────────────
  // Source: TaskSummary.artifactCount summed over Completed tasks.
  // Clean source — no v0.2 fallback needed. Granularity: substrate-wide.
  {
    kind: 'artifactBandwidth',
    granularity: 'substrateWide',
    sourceFields: ['artifactCount', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      let total = 0;
      for (const t of s.tasks.values()) {
        if (t.phase === 'Completed' && (t.artifactCount ?? 0) > 0) {
          total += t.artifactCount ?? 0;
        }
      }
      if (total === 0) return [];
      return [
        {
          kind: 'artifactBandwidth',
          sourceFields: ['artifactCount', 'phase'],
          detailLink: '#/cluster',
          label: 'completed-task artifacts',
          value: total,
          unit: 'artifacts',
        },
      ];
    },
    detailLink: (): string => '#/cluster',
  },

  // ─────────────────────────── authority ───────────────────────────
  // Ideal source: structured 'policy_denied' audit event. v0.2 fallback:
  // TaskSummary error-string match for 'policy' (same as pressure.ts policy marker).
  // Promote when audit-event surface lands in workbench-api. Granularity: substrate-wide.
  {
    kind: 'authority',
    granularity: 'substrateWide',
    sourceFields: ['error', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      let count = 0;
      for (const t of s.tasks.values()) {
        if (t.phase === 'Failed' && (t.error?.toLowerCase().includes('policy') ?? false)) {
          count++;
        }
      }
      if (count === 0) return [];
      return [
        {
          kind: 'authority',
          sourceFields: ['error', 'phase'],
          detailLink: '#/tasks',
          label: 'policy denials',
          value: count,
          unit: 'denials',
        },
      ];
    },
    detailLink: (): string => '#/tasks',
  },

  // ─────────────────────────── trust ───────────────────────────
  // Ideal source: pilotEvidence.verification.passed on TaskDetail. v0.2 fallback:
  // TaskSummary.suspicious + error-string match for 'verifier' (same as
  // pressure.ts verifier marker). Promote when pilotEvidence reaches TaskSummary.
  // Granularity: substrate-wide.
  {
    kind: 'trust',
    granularity: 'substrateWide',
    sourceFields: ['suspicious', 'error', 'phase'],
    compute: (s): readonly FlowGauge[] => {
      let count = 0;
      for (const t of s.tasks.values()) {
        const hasSuspicious = (t.suspicious?.length ?? 0) > 0;
        const hasVerifierError =
          t.phase === 'Failed' && (t.error?.toLowerCase().includes('verifier') ?? false);
        if (hasSuspicious || hasVerifierError) {
          count++;
        }
      }
      if (count === 0) return [];
      return [
        {
          kind: 'trust',
          sourceFields: ['suspicious', 'error', 'phase'],
          detailLink: '#/tasks',
          label: 'trust events',
          value: count,
          unit: 'events',
        },
      ];
    },
    detailLink: (): string => '#/tasks',
  },

  // ─────────────────────────── attention ───────────────────────────
  // Phase 4 — source flipped to /api/review-queue rows count.
  // REV-03: replay-divergence and eval-failed reasons are reserved for
  // AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
  // pre-implementation as of 2026-05-10). v0.2 producers: zero.
  {
    kind: 'attention',
    granularity: 'substrateWide',
    sourceFields: ['reviewQueueRowCount'],
    compute: (s): readonly FlowGauge[] => {
      const count = s.reviewQueueRowCount ?? 0;
      if (count === 0) return [];
      return [
        {
          kind: 'attention',
          sourceFields: ['reviewQueueRowCount'],
          detailLink: '#/review',
          label: 'review queue',
          value: count,
          unit: 'items',
        },
      ];
    },
    detailLink: (): string => '#/review',
  },
];

/**
 * Derived from FLOW_TYPES['kind'] so the closed-enum stays in
 * one place. Resolves to the union of all eight kind literals
 * automatically because FLOW_TYPES is populated.
 */
export type FlowFieldName = FlowType['kind'];
