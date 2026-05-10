/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * pressure — Phase 2 / CC-04. UI-side classification of nine
 * pressure types from existing CommandSnapshot fields. No new
 * workbench-api endpoint, no new substrate state. Each entry in
 * PRESSURE_TYPES declares its source field(s), classify function,
 * and detail-link computation. Wave 1 fills in the per-type
 * implementations; this Wave-0 scaffold only fixes the shape.
 *
 * See COMMAND-CENTER-CONTRACT.md §6 Pressure Systems for the nine
 * canonical pressure types, and CONTEXT.md D-CC-04-A for the
 * decision to derive all 9 UI-side from snapshot fields.
 */

import type { CommandSnapshot } from './state.js';

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
 * Wave 0 scaffold — empty array. Wave 1 (02-02-PLAN.md) populates
 * with all nine entries (gateway, artifact, pod, quota, telemetry,
 * context, verifier, trace, policy) per CONTEXT.md D-CC-04-A.
 */
export const PRESSURE_TYPES: readonly PressureType[] = [];

/**
 * Derived from PRESSURE_TYPES['kind'] so the closed-enum stays in
 * one place. After Wave 1 populates PRESSURE_TYPES, this becomes
 * the union of all nine kind literals automatically.
 */
export type PressureFieldName = PressureType['kind'];
