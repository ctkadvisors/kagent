/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@ctkadvisors/mcp-tool-provider` — MCP stdio `ToolProvider` impl for `@kagent/agent-loop`.
 *
 * Errors thrown by this provider (`McpToolProviderProtocolError`,
 * `McpToolProviderSubprocessError`, `McpToolProviderAbortError`) extend
 * the `ToolProviderError` family exported from `@kagent/agent-loop`
 * (Phase 5 D-24); consumers import from there to avoid dual-source
 * `instanceof` ambiguity.
 */

export { McpToolProvider } from './provider.js';
export type { McpToolProviderOptions } from './provider.js';
