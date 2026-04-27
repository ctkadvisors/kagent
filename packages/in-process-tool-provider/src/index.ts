/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@ctkadvisors/in-process-tool-provider` — In-process `ToolProvider` impl for
 * `@kagent/agent-loop`. Invokes plain JS functions as tools without
 * subprocess overhead.
 *
 * Construction-time errors throw `InvalidConfigError` from
 * `@kagent/agent-loop` (Phase 3 D-22 family). This package exports NO
 * error subclass family — handler throws map to `ToolResult{isError:true}`
 * not propagated (CONTEXT D-26). Consumers import `InvalidConfigError`
 * directly from `@kagent/agent-loop` for the construction-time catch.
 */

export { InProcessToolProvider } from './provider.js';
export { defineInProcessTool } from './define.js';
export type {
  InProcessToolDefinition,
  InProcessToolProviderOptions,
  InProcessToolReturn,
} from './provider.js';
