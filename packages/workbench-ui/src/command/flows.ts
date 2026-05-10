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
 *
 * STUB — implementation pending (Wave 1 RED phase). FLOW_TYPES will
 * be populated in the GREEN commit.
 */

import type { CommandSnapshot } from './state.js';

export interface FlowGauge {
  readonly kind: FlowType['kind'];
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly affectedKey?: string;
  readonly detailLink: string;
  readonly label: string;
  readonly value: number;
  readonly capacity?: number;
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

// Stub — will be populated in GREEN commit
export const FLOW_TYPES: readonly FlowType[] = [];

/**
 * Derived from FLOW_TYPES['kind'] so the closed-enum stays in
 * one place. Resolves to the union of all eight kind literals
 * automatically because FLOW_TYPES is populated.
 */
export type FlowFieldName = FlowType['kind'];
