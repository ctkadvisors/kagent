/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/operator` — Kubernetes control plane that watches Agent +
 * AgentTask + AgentCapability CRDs and materializes pods. Public
 * surface re-exports the testable building blocks; the operator is
 * normally run via `pnpm --filter @kagent/operator start` (entry
 * point: `src/main.ts`, added in Phase 2 C3).
 */

export { StubDispatcher } from './dispatcher.js';
export type { Dispatcher, DispatchedTask } from './dispatcher.js';

export { API_GROUP, API_VERSION, API_GROUP_VERSION, isAgent, isAgentTask } from './crds/index.js';
export type {
  Agent,
  AgentSpec,
  AgentTask,
  AgentTaskSpec,
  AgentTaskStatus,
  AgentTaskPhase,
  AgentCapability,
  AgentCapabilitySpec,
} from './crds/index.js';
