/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import * as mod from './index.js';
import { McpToolProvider } from './index.js';
import type { ToolProvider } from '@kagent/agent-loop';

describe('@ctkadvisors/mcp-tool-provider — barrel contract', () => {
  it('Test 12a — McpToolProvider is exported as a constructor', () => {
    expect(typeof mod.McpToolProvider).toBe('function');
    const p = new mod.McpToolProvider({ command: 'true' });
    expect(p.id).toBe('mcp-stdio');
  });

  it('Test 12b — runtime ToolProvider satisfies (compile + runtime check)', () => {
    const p = new McpToolProvider({ command: 'true' });
    // Compile-time: type assignability.
    const _typecheck: ToolProvider = p;
    void _typecheck;
    // Runtime: shape assertions.
    expect('id' in p).toBe(true);
    expect(typeof p.describeTools).toBe('function');
    expect(typeof p.executeTool).toBe('function');
  });

  it('Test 12c — barrel does NOT re-export error classes (PATTERNS discipline)', () => {
    // Error classes live in @kagent/agent-loop — single source of truth for instanceof.
    expect('ToolProviderError' in mod).toBe(false);
    expect('InvalidConfigError' in mod).toBe(false);
    expect('McpToolProviderAbortError' in mod).toBe(false);
    expect('McpToolProviderSubprocessError' in mod).toBe(false);
    expect('McpToolProviderProtocolError' in mod).toBe(false);
  });

  it('Test 12d — barrel does NOT export scaffold placeholders', () => {
    expect('SCAFFOLD_VERSION' in mod).toBe(false);
  });
});
