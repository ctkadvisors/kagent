/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/agent-pod` — in-pod runtime that hosts `@kagent/agent-loop`,
 * runs a single AgentTask, and writes the result to status. Public
 * surface re-exports the testable building blocks; the pod normally
 * runs via `bun src/main.ts` (Dockerfile entrypoint, Phase 3 C7).
 */

export { parseEnv } from './env.js';
export type { AgentSpecEnv, PodConfig, TaskSpecEnv } from './env.js';

export { runAgentTask, pickUserMessage, resolveToolProviders } from './runner.js';
export type { ArtifactRef, RunDeps, RunResult } from './runner.js';

export {
  buildBuiltinToolRegistry,
  resolveBuiltinTools,
  parseAllowedDomains,
  isHostAllowed,
  assertUrlIsSafe,
  extractTextFromHtml,
  parseFeed,
  ENV_ALLOW_DOMAINS,
} from './builtin-tools.js';
export type { RssItem } from './builtin-tools.js';

export { buildStatusPatch, writeStatus, makeCustomObjectsApi } from './status.js';
export type { StatusPatch } from './status.js';
