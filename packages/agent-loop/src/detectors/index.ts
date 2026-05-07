/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Run-end detector middleware — pure heuristics over the trace + final
 * assistant message + originating user prompt. Lifted from the
 * homelab-orchestrator chat-server harness (see docs/HARNESS-LESSONS.md).
 *
 * Designed to run inside `@kagent/agent-loop` after `AgentExecutor.run()`
 * returns, before the result envelope is published over A2A.
 */

export {
  computeQualityFlags,
  detectContextPressureIgnored,
  type ContextPressureOpts,
} from './quality-flags.js';
export { detectRefusal } from './refusal.js';
