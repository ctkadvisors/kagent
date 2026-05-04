/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/agent-workflow-runtime` — Wave 2 / Workflows host SDK.
 *
 * Workflow authors import this package + Restate's TS SDK (added by
 * the consuming repo, not the operator). The kagent operator's
 * AgentWorkflow controller deploys the user-supplied image, registers
 * the handler with Restate via the admin API, wires triggers via Wave
 * 0 Entry, and threads the workflow's capability bundle into the
 * runtime Deployment via Secret-volume.
 *
 * Public surface (per docs/WAVES.md §4.3):
 *
 *   - `defineWorkflow({ name, run })` — wrap a deterministic handler
 *     in a `WorkflowDefinition`.
 *   - `WorkflowContext` — `ctx.spawnAgentTask`, `ctx.awaitTask`,
 *     `ctx.signal`, `ctx.awaitSignal`, `ctx.sleep`.
 *   - `WorkflowTaskFailedError` / `WorkflowTimeoutError` — typed
 *     error throws for the two failure axes a workflow author cares
 *     about (a child task failed; an external signal didn't arrive
 *     within the timeout).
 *   - `createInMemoryRunner` — vitest harness that drives a workflow
 *     definition through fresh-execute + replay paths without a real
 *     Restate cluster. Crash-recovery test depends on it.
 *
 * The Restate adapter (`toRestateService(...)`) lands in a follow-up
 * release once the operator's controller is exercising real Restate
 * in the homelab. v0.3.2 ships:
 *   - The deterministic API surface (this file).
 *   - The in-memory runtime (crash-recovery proof).
 *   - The CRD + controller wiring (sibling commits).
 */

export { defineWorkflow } from './define-workflow.js';

export type {
  AgentTaskHandle,
  AgentTaskOutputs,
  AwaitSignalInput,
  DefineWorkflowInput,
  SignalInput,
  SpawnAgentTaskInput,
  WorkflowContext,
  WorkflowDefinition,
} from './types.js';
export { WorkflowTaskFailedError, WorkflowTimeoutError } from './types.js';

export { createInMemoryRunner } from './in-memory-runtime.js';
export type { InMemoryRunner, InMemoryRunState, SideEffectFns } from './in-memory-runtime.js';
