/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Protected contracts for credentialed providers. This entry point must never
 * evaluate the fleet-owned executor, runtime barrel, detectors, or trace code.
 * Every transitive source dependency belongs to the protected kernel grant.
 */
export { AgentRegistry } from './registry.js';
export { ToolProviderRegistry } from './tool-provider.js';
export * from './errors.js';
export { MALFORMED_TOOL_ARGS, malformedToolArgs } from './llm-client.js';
export type * from './types.js';
export type {
  LLMClient,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatDelta,
  ClientContext,
  ToolCall,
} from './llm-client.js';
export type {
  ToolProvider,
  ToolDescriptor,
  ToolResult,
  ToolInvocationContext,
  ContentBlock,
  JSONSchema,
} from './tool-provider.js';
