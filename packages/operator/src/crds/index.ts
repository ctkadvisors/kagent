/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export { API_GROUP, API_VERSION, API_GROUP_VERSION, isAgent, isAgentTask } from './types.js';
export type {
  Agent,
  AgentSpec,
  AgentTask,
  AgentTaskSpec,
  AgentTaskStatus,
  AgentTaskCondition,
  AgentTaskPhase,
  AgentTaskRunConfig,
  AgentCapability,
  AgentCapabilitySpec,
} from './types.js';

export {
  DEFAULT_ARTIFACT_PVC,
  INLINE_DEFAULT_MAX_BYTES,
  inlineSafe,
  isArtifactRef,
  parseArtifactUri,
  pvcUri,
} from './artifact-ref.js';
export type {
  ArtifactRef,
  ArtifactScheme,
  InlineDecision,
  ParsedArtifactUri,
} from './artifact-ref.js';
