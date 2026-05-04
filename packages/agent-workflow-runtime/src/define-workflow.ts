/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `defineWorkflow` — public entry point for workflow authors.
 *
 * Wraps the user's run function in a `WorkflowDefinition` that the
 * Restate adapter (`restate-adapter.ts`) and the in-memory test
 * harness (`in-memory-runtime.ts`) both consume.
 *
 * Author surface (per docs/WAVES.md §4.3):
 *
 * ```ts
 * import { defineWorkflow } from '@kagent/agent-workflow-runtime';
 *
 * export const researchOrchestrator = defineWorkflow({
 *   name: 'researchOrchestrator',
 *   async run(input: { topic: string }, ctx) {
 *     const t1 = await ctx.spawnAgentTask('summarize', {
 *       agent: 'summarizer',
 *       inputs: [{ name: 'topic', from: { scalar: input.topic } }],
 *     });
 *     const t2 = await ctx.spawnAgentTask('validate', {
 *       agent: 'validator',
 *       inputs: [{ name: 'taskRef', from: { taskUid: t1.taskUid, output: 'summary' } }],
 *     });
 *     const r1 = await ctx.awaitTask('await-summary', t1);
 *     const r2 = await ctx.awaitTask('await-validation', t2);
 *     return { summary: r1, validation: r2 };
 *   },
 * });
 * ```
 *
 * The user's image entrypoint then registers this with Restate:
 *
 * ```ts
 * import * as restate from '@restatedev/restate-sdk';
 * import { toRestateService } from '@kagent/agent-workflow-runtime/restate';
 * import { researchOrchestrator } from './workflows.js';
 *
 * restate.serve({ services: [toRestateService(researchOrchestrator)], port: 9080 });
 * ```
 *
 * v0.3.2 ships the host SDK + the in-memory test harness. The
 * `toRestateService` adapter ships in `restate-adapter.ts`.
 */

import type { DefineWorkflowInput, WorkflowDefinition } from './types.js';

/**
 * Wrap a user-supplied workflow handler in a `WorkflowDefinition`.
 *
 * The returned object's only public field is `name`. The internal
 * `_run` field is consumed by the Restate adapter and the in-memory
 * test harness; both go through `defineWorkflow`'s output rather than
 * letting consumers stitch a context themselves — keeps the
 * deterministic-step contract enforceable from one place.
 */
export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  input: DefineWorkflowInput<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new Error('defineWorkflow: `name` is required and must be a non-empty string');
  }
  if (typeof input.run !== 'function') {
    throw new Error('defineWorkflow: `run` must be a function');
  }
  // The Restate handler name follows JS-identifier conventions; we
  // do a defensive narrow here so a typo at authoring time fails
  // fast rather than at Restate-register time (which logs to the pod
  // and never bubbles up).
  if (!/^[a-zA-Z_$][\w$]*$/.test(input.name)) {
    throw new Error(
      `defineWorkflow: name "${input.name}" is not a valid JS-identifier; ` +
        `Restate registers the value verbatim and rejects non-identifier names.`,
    );
  }
  // Bind the handler verbatim — `input.run` may be a method on a
  // class or an object literal; binding to `input` preserves `this`
  // semantics for class-based authors while detaching for property-
  // method ones (the eslint unbound-method rule's concern).
  const handler = input.run.bind(input);
  return {
    name: input.name,
    _run: handler,
  };
}
