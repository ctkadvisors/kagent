/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory `ToolProvider` stubs for `ToolProvider` and `AgentExecutor` unit tests.
 *
 * Factory fn matching `__fixtures__/agents.ts` style. Consumed only by
 * `*.test.ts` siblings — never re-exported from the package barrel (Phase 2 D-21).
 */

import type {
  ToolProvider,
  ToolDescriptor,
  ToolResult,
  ToolInvocationContext,
} from '../tool-provider.js';
import type { ToolCall } from '../llm-client.js';

export interface StubToolProviderOptions {
  id?: string;
  tools?: ToolDescriptor[];
  /** Hook invoked per executeTool call. Return a ToolResult; throw to test error path. */
  onCall?: (call: ToolCall, ctx: ToolInvocationContext) => Promise<ToolResult> | ToolResult;
  /** Mutated by the stub: every executeTool call appended for assertions. */
  recordedCalls?: ToolCall[];
}

/** Build an in-memory `ToolProvider`. */
export function makeStubToolProvider(opts: StubToolProviderOptions = {}): ToolProvider {
  const id = opts.id ?? 'in-process';
  const tools = opts.tools ?? [];
  return {
    id,
    describeTools(): ToolDescriptor[] {
      return tools;
    },
    async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
      opts.recordedCalls?.push(call);
      if (opts.onCall) {
        return await opts.onCall(call, ctx);
      }
      return { content: 'ok', isError: false };
    },
  };
}
