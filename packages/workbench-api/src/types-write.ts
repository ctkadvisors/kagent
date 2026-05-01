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
