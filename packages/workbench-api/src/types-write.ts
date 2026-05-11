/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Request/response DTOs for the workbench-api WRITE surface (POST
 * handlers). Read DTOs live in `@kagent/dto`; these stay local because
 * the write contract is workbench-only — nothing else in the monorepo
 * needs `CreateTaskRequest` today. Promote to `@kagent/dto` if a
 * second consumer (CLI imports it directly, webhook handlers, etc.)
 * needs the type.
 */

/**
 * Phase 5 / WB-03 — Optional replay-of reference.
 *
 * Shape is intentionally duplicated from workbench-ui's types.ts to
 * keep both packages leaf-dep-only (no shared @kagent/dto edge for
 * the write contract). The workbench-api is the wire authority; the
 * workbench-ui has its own copy. See CONTEXT.md D-03.
 */
export interface ReplayOfReference {
  /** Reference to the original task being replayed. */
  readonly taskRef: {
    /** K8s namespace of the original task. RFC1123 label shape. */
    readonly namespace: string;
    /** K8s name of the original task. RFC1123 label shape. */
    readonly name: string;
    /** Optional UID of the original task (for idempotency / cross-check). */
    readonly uid?: string;
  };
  /**
   * Optional operator-provided reason for the replay.
   * Max 256 bytes UTF-8; no newlines.
   */
  readonly reason?: string;
}

export interface CreateTaskRequest {
  /** Target Agent CR name. Required. K8s RFC1123 label shape. */
  readonly targetAgent: string;
  /** Prompt that seeds the agent's run. Required. Capped at 32KB. */
  readonly originalUserMessage: string;
  /** Optional namespace. Default = workbench-api's release namespace. */
  readonly namespace?: string;
  /** Optional name. Default = `manual-${nanoid8}`. */
  readonly name?: string;
  /** Optional run-config knobs (timeout, max iterations). */
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
  };
  /**
   * Optional user-supplied labels. Operator-managed labels (the
   * `kagent.knuteson.io/*` prefix) are rejected — those are reserved.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /** Opaque structured payload — forwarded verbatim to AgentTask.spec.payload. */
  readonly payload?: unknown;
  /**
   * Phase 5 / WB-03 — Optional replay-of reference. When present, the
   * POST /api/tasks 5-step handler (Plan 02) resolves the original task
   * from SnapshotCache and materializes 5 kagent.knuteson.io/replay-*
   * annotations on the new AgentTask. See CONTEXT.md D-03.
   */
  readonly replayOf?: ReplayOfReference;
}

export interface CreateTaskResponse {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly createdAt: string;
  readonly phase: 'Pending';
  readonly _links: {
    readonly detail: string;
    readonly ui: string;
  };
}

export interface CreateTaskErrorBody {
  readonly error: string;
  /** Per-field validation errors. Present on 400/422 responses. */
  readonly fields?: ReadonlyArray<{
    readonly field: string;
    readonly code: string;
    readonly detail?: string;
  }>;
}
