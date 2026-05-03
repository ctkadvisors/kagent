/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Public surface of @kagent/llm-gateway. Re-exports:
 *
 *   - core types (BackendKind, ModelEndpoint, ChatCompletionRequest, ...)
 *   - the AIMD + in-flight + model-index primitives (testable on their own)
 *   - the router orchestrator
 *   - server start helper (importers can mount the gateway in-process)
 *   - env parser
 *
 * The pod's main entrypoint is `./main.ts` (run via `pnpm start` or
 * the Dockerfile's `node dist/main.js`); main is NOT re-exported from
 * here — importers should never `require('@kagent/llm-gateway')` and
 * accidentally start a server.
 */

export type {
  AIProvider,
  BackendKind,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  FunctionCall,
  ModelEndpoint,
  ModelEndpointSpec,
  ModelEndpointStatus,
  ModelListResponse,
  ModelObject,
  OpenAIError,
  OpenAIErrorType,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
  ToolCall,
  Usage,
} from './types.js';
export { createOpenAIError } from './types.js';

export {
  AimdController,
  type AimdBounds,
  type AimdOptions,
  type AimdSnapshotEntry,
} from './aimd.js';
export { InFlightCounter, type InFlightSnapshotEntry } from './inflight-counter.js';
export { ModelIndex, type ModelLookup } from './model-index.js';
export { route, type RouteContext, type RouteResult, type RouterDeps } from './router.js';
export { startServer, buildHandler, type ServerDeps, type StartedServer } from './server.js';
export { parseEnv, type GatewayConfig } from './env.js';
export {
  authenticate,
  hashApiKey,
  type ApiKeyInfo,
  type ApiKeyLookup,
  type AuthResult,
} from './auth.js';
export { parseKagentHeaders, type KagentHeaders } from './headers.js';
export {
  buildCapacityResponse,
  buildUsageResponse,
  parseUsageQuery,
  adminAuth,
  type CapacityResponse,
  type CapacityRow,
} from './admin-routes.js';
export { buildProvider, type ProviderFactoryOptions } from './providers/provider-factory.js';
export { createUsageRecorder, type UsageEvent, type UsageRecorder } from './usage-recorder.js';
