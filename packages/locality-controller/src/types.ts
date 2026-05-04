/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Locality sub-team — minimal structural shapes the helpers
 * need from the operator's CRD types. Kept narrow + structural so the
 * package has zero workspace-level dep on `@kagent/operator` (which
 * already depends on this package via main.ts wiring — a back-edge
 * would create the import cycle).
 *
 * The operator's full `Agent` / `AgentTask` / `Workspace` types are
 * structurally compatible with these; TypeScript's structural typing
 * lets the operator pass its CRD objects in verbatim.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

/* =====================================================================
 * Agent shape — only the fields the locality helpers read.
 * ===================================================================== */

export interface AffinityInputDecl {
  readonly name: string;
  readonly kind: 'workspace' | 'artifact' | 'scalar';
}

export interface AffinityAgentSpec {
  readonly inputs?: readonly AffinityInputDecl[];
}

export interface AffinityAgent {
  readonly metadata: V1ObjectMeta;
  readonly spec: AffinityAgentSpec;
}

/* =====================================================================
 * AgentTask shape
 * ===================================================================== */

export interface AffinityInputBinding {
  readonly name: string;
  /**
   * The discriminated union the operator's CRD types model precisely;
   * here we only need the `workspace` field. A binding with another
   * shape (`taskUid+output`, `scalar`) lacks `.workspace` and the
   * helper just skips it.
   */
  readonly from: { readonly workspace?: string } | Record<string, unknown>;
}

export interface AffinityAgentTaskSpec {
  readonly inputs?: readonly AffinityInputBinding[];
}

export interface AffinityTask {
  readonly metadata: V1ObjectMeta;
  readonly spec: AffinityAgentTaskSpec;
}

/* =====================================================================
 * Workspace shape — only `status.pvcName` + `status.bytesUsed`.
 * ===================================================================== */

export interface WorkspaceStatusShape {
  readonly pvcName?: string;
  readonly bytesUsed?: number;
}

export interface Workspace {
  readonly metadata: V1ObjectMeta;
  readonly status?: WorkspaceStatusShape;
}
