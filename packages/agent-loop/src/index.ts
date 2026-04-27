/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Package version.
 *
 * Updated by @changesets/cli on publish. Source of truth during
 * development is this export; do not import from package.json.
 */
export const VERSION = '0.0.0' as const;

/**
 * Phase 1 scaffold contract — proves the package can be imported,
 * its banner is lint-clean, and its type surfaces through dist/.
 */
export function scaffoldOk(): `agent-runtime v${typeof VERSION} — scaffold OK` {
  return `agent-runtime v${VERSION} — scaffold OK`;
}

// =====================================================================
// Phase 2 — AgentRegistry public API (D-20)
// =====================================================================

/**
 * Generic agent registry with pluggable types, phases, and skills.
 * See `AgentRegistry` source for per-method docs.
 */
export { AgentRegistry } from './registry.js';

/**
 * Error classes thrown by `AgentRegistry`. The parent `AgentRegistryError`
 * is exported alongside the concrete subclasses so consumers can catch
 * registry-family errors broadly (`catch (err) { if (err instanceof AgentRegistryError) … }`)
 * or narrowly by subclass type.
 */
export {
  AgentRegistryError,
  DuplicateAgentTypeError,
  DuplicateSkillIdError,
  UnknownAgentTypeError,
} from './errors.js';

/**
 * Type declarations consumed by consumers parameterizing `AgentRegistry`.
 * Erased at emit under `verbatimModuleSyntax: true`.
 */
export type {
  AgentDefinition,
  AgentSkill,
  AgentSuitability,
  AgentRecommendation,
} from './types.js';

// =====================================================================
// Phase 3 — AgentExecutor + Kernel Interfaces public API
// =====================================================================

/**
 * Vendor-agnostic LLM and tool-use loop. Consumers compose
 * `AgentRegistry` + `LLMClient` + `ToolProvider`s into an executor;
 * Phase 4+ ship concrete `LLMClient` impls; Phase 5+ ship concrete
 * `ToolProvider` impls; Phase 6+ ship concrete `TraceSink` impls.
 */
export { AgentExecutor } from './executor.js';
export { ToolProviderRegistry } from './tool-provider.js';

/**
 * Pure trace utilities — token estimation and storage truncation.
 * Provider impls and consumers use these to populate `TraceEntry` fields
 * consistently with the loop's accounting.
 */
export { estimateTokens, truncateForStorage, truncateMessages } from './trace.js';

/**
 * Error classes thrown by `AgentExecutor`. Parent `AgentExecutorError`
 * exported alongside subclasses for broad-or-narrow `instanceof` catch.
 */
export {
  AgentExecutorError,
  AgentNotFoundError,
  NoLLMClientError,
  NoToolProviderError,
  InvalidConfigError,
  NotImplementedError,
  DuplicateToolNameError,
} from './errors.js';

// =====================================================================
// Phase 4 — LLMClient error family (D-16)
// =====================================================================

/**
 * Error classes thrown by `LLMClient` adapter packages (e.g.,
 * `@ctkadvisors/openai-compat-client`). Parent `LLMClientError` exported
 * alongside subclasses for broad-or-narrow `instanceof` catch.
 *
 * Adapter and executor errors are SIBLING families: a `LLMClientHttpError`
 * thrown by an adapter is NOT `instanceof AgentExecutorError`. The executor
 * catches the adapter family separately and maps to `ExecutionResult.status`.
 */
export {
  LLMClientError,
  LLMClientHttpError,
  LLMClientProtocolError,
  LLMClientAbortError,
  LLMClientTimeoutError,
} from './errors.js';

// =====================================================================
// Phase 5 — ToolProvider error family (D-25)
// =====================================================================

/**
 * Error classes thrown by `ToolProvider` adapter packages
 * (`@ctkadvisors/http-tool-provider`, `@ctkadvisors/mcp-tool-provider`). Parent
 * `ToolProviderError` exported alongside subclasses for broad-or-narrow
 * `instanceof` catch.
 *
 * Adapter, executor, LLM-client, and tool-provider errors are all
 * SIBLING families: a `HttpToolProviderNetworkError` thrown by an
 * adapter is NOT `instanceof AgentExecutorError` and NOT `instanceof
 * LLMClientError`. The executor catches the family separately and
 * maps tool-provider throws to `ToolResult{isError:true}` per the
 * loop convention.
 *
 * Note: `InProcessToolProvider` has no provider-level failure mode
 * (D-26) — handler throws map to `ToolResult{isError:true}` not
 * propagated, so no `InProcessToolProviderError` subclass exists.
 */
export {
  ToolProviderError,
  HttpToolProviderNetworkError,
  HttpToolProviderConfigError,
  McpToolProviderProtocolError,
  McpToolProviderSubprocessError,
  McpToolProviderAbortError,
} from './errors.js';

/**
 * Type declarations consumed by Phase 4+ adapter packages.
 * Erased at emit under `verbatimModuleSyntax: true`.
 */
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
export type { TraceEntry, TraceSink } from './trace.js';
export type {
  RunBudget,
  TerminalStatus,
  ExecutionResult,
  RunInput,
  AgentExecutorOptions,
} from './executor.js';
