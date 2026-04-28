/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/agent-pod` — in-pod runtime that hosts `@kagent/agent-loop`,
 * runs a single AgentTask, and writes the result to status. Public
 * surface re-exports the testable building blocks; the pod normally
 * runs via `node --import tsx/esm src/main.ts` (Dockerfile entrypoint;
 * Bun was the original v0.1 target but reverted in Phase 4.x — see
 * the agent-pod Dockerfile + main.ts header for the TLS-parity story).
 */

export { parseEnv } from './env.js';
export type { AgentSpecEnv, AgentTaskRunConfigEnv, PodConfig, TaskSpecEnv } from './env.js';

export { composeSignals, pickUserMessage, resolveToolProviders, runAgentTask } from './runner.js';
export type { ArtifactRef, RunDeps, RunResult } from './runner.js';

export { buildCancelledResult, buildShutdownPlan } from './main.js';
export type { ShutdownPlan } from './main.js';

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

export {
  buildPvcUri,
  inlineSafeForArtifact,
  isArtifactRefShape,
  resolveWriterEnv,
  tryParseArtifactRefFromToolOutput,
  validateArtifactName,
  writeArtifactToDisk,
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PVC_NAME,
  ENV_ARTIFACTS_DIR,
  ENV_ARTIFACTS_PVC_NAME,
  ENV_TASK_ID,
  INLINE_DEFAULT_MAX_BYTES,
} from './artifacts.js';
export type { ArtifactWriterEnv, WriteArtifactResult } from './artifacts.js';
