/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@ctkadvisors/http-tool-provider` — HTTP REST `ToolProvider` impl for
 * `@kagent/agent-loop`. Calls arbitrary endpoints with configurable
 * auth + path templating; surfaces non-2xx as `ToolResult{isError:true}`
 * (the LLM sees the failure as a `role: 'tool'` message and can recover)
 * rather than raw throws.
 *
 * Errors thrown by this provider (`HttpToolProviderNetworkError`,
 * `HttpToolProviderConfigError`) extend the `ToolProviderError` family
 * exported from `@kagent/agent-loop` (Phase 5 D-24); consumers import
 * from there to avoid dual-source `instanceof` ambiguity.
 */

export { HttpToolProvider } from './provider.js';
export type { HttpToolProviderOptions, HttpToolDefinition } from './provider.js';
