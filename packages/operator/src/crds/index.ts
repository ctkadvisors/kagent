/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  isAgent,
  isAgentTask,
  isModelEndpoint,
} from './types.js';
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
  ModelEndpoint,
  ModelEndpointSpec,
  ModelEndpointStatus,
  ModelEndpointInFlight,
  ModelEndpointBackendKind,
  /* v0.2.0-typed-io — typed dataflow contract surface */
  InputDecl,
  InputKind,
  InputMode,
  OutputDecl,
  OutputKind,
  InputBinding,
  InputFrom,
  OutputRef,
  /* v0.3.1-supervision — Wave 2 / Supervision sub-team */
  SupervisionStrategy,
  /* v0.4.0-events — Wave 3 / Events sub-team */
  EventPublishDecl,
  EventSubscribeDecl,
  EventSubscribeTrigger,
} from './types.js';

export {
  casUri,
  DEFAULT_ARTIFACT_PVC,
  INLINE_DEFAULT_MAX_BYTES,
  inlineSafe,
  isArtifactRef,
  parseArtifactUri,
  parseUri,
  pvcUri,
} from './artifact-ref.js';
export type {
  ArtifactRef,
  ArtifactScheme,
  InlineDecision,
  ParsedArtifactUri,
  ParsedUri,
} from './artifact-ref.js';

/* v0.2.0-typed-io — typed dataflow contract helpers */
export {
  inputIsRequired,
  inputsMissingMountPath,
  outputIsRequired,
  publishTopicsOfAgent,
  requiredInputNames,
  requiredOutputNames,
  subscribeTopicsOfAgent,
} from './agent.js';
export {
  fromKindOrNull,
  hashTaskInputs,
  isFromScalar,
  isFromTaskUidOutput,
  isFromWorkspace,
  outputsByName,
  validateInputBindings,
} from './agent-task.js';
export type { InputValidationResult } from './agent-task.js';

export { isKagentSchedule } from './kagent-schedule.js';
export type {
  KagentSchedule,
  KagentScheduleSpec,
  KagentScheduleStatus,
  KagentScheduleTaskTemplate,
} from './kagent-schedule.js';

/* v0.2.1-workspaces — Workspace primitive (Wave 1 / Workspace sub-team).
 * See docs/SUBSTRATE-V1.md §3.4 + docs/WAVES.md §3.2. */
export {
  DEFAULT_WORKSPACE_TTL_MS,
  isWorkspace,
  isWorkspaceFailed,
  isWorkspaceReady,
  parseDuration,
  resolveWorkspaceTtlMs,
} from './workspace.js';
export type {
  Workspace,
  WorkspaceCondition,
  WorkspaceGitSource,
  WorkspacePhase,
  WorkspacePvcSpec,
  WorkspaceQuota,
  WorkspaceSource,
  WorkspaceSpec,
  WorkspaceStatus,
} from './workspace.js';

/* v0.3.2-workflows — AgentWorkflow primitive (Wave 2 / Workflows sub-team).
 * See docs/SUBSTRATE-V1.md §3.3 + docs/WAVES.md §4.3. */
export {
  deploymentNameForAgentWorkflow,
  isAgentWorkflow,
  isAgentWorkflowFailed,
  isAgentWorkflowReady,
  isEventTrigger,
  isScheduleTrigger,
  isWebhookTrigger,
  serviceNameForAgentWorkflow,
} from './agent-workflow.js';
export type {
  AgentWorkflow,
  AgentWorkflowCondition,
  AgentWorkflowEventTrigger,
  AgentWorkflowPhase,
  AgentWorkflowScheduleTrigger,
  AgentWorkflowSpec,
  AgentWorkflowStatus,
  AgentWorkflowTrigger,
  AgentWorkflowWebhookTrigger,
} from './agent-workflow.js';
