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

export { agentHasArtifactInputOrOutput, parseEnv, parseIdentityConfig } from './env.js';
export type {
  AgentSpecEnv,
  AgentTaskRunConfigEnv,
  PodConfig,
  PodIdentityConfig,
  TaskSpecEnv,
} from './env.js';

export { composeSignals, pickUserMessage, resolveToolProviders, runAgentTask } from './runner.js';
export type { ArtifactRef, RunDeps, RunResult } from './runner.js';

/* v0.4.3-identity — Wave 3 / Identity sub-team SVID consumer + mTLS probe. */
export { loadIdentityHandle, probeGatewayMtls } from './svid-client.js';
export type {
  IdentityHandle,
  LoadIdentityHandleInput,
  ProbeFetchResponse,
  ProbeGatewayMtlsInput,
  ProbeGatewayMtlsResult,
  SvidMaterial,
  SvidMtlsContext,
} from './svid-client.js';

export { buildCancelledResult, buildShutdownPlan } from './main.js';
export type { ShutdownPlan } from './main.js';

export {
  buildBuiltinToolRegistry,
  defineReadArtifact,
  resolveBuiltinTools,
  parseAllowedDomains,
  isHostAllowed,
  assertUrlIsSafe,
  extractTextFromHtml,
  parseFeed,
  ENV_ALLOW_DOMAINS,
} from './builtin-tools.js';
export type { ReadArtifactDeps, RssItem } from './builtin-tools.js';

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

/* v0.2.2-cas — content-addressed-storage backend abstraction. */
export { casShardPath, hashBytes, PvcCasBackend, S3CasBackend } from './cas-backend.js';
export type { CasBackend, CasWriteResult, S3CasBackendOptions } from './cas-backend.js';
