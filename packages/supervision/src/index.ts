/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/supervision` — Erlang/OTP-style supervision strategies for
 * AgentTask trees. Pure-functional engine consumed by the operator
 * reconciler. See docs/WAVES.md §4.2 + the JSDoc on `./strategy.ts`
 * for the design.
 */

export {
  ALL_SUPERVISION_STRATEGIES,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_SUPERVISION_STRATEGY,
} from './types.js';
export type {
  FailedChild,
  SiblingTask,
  SupervisionAction,
  SupervisionDecision,
  SupervisionStrategy,
  TaskRef,
} from './types.js';

export { assertStrategyAllowed, evaluateStrategy } from './strategy.js';
