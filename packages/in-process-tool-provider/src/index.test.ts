/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import * as mod from './index.js';
import { InProcessToolProvider, defineInProcessTool } from './index.js';
import type { ToolProvider } from '@kagent/agent-loop';

describe('@ctkadvisors/in-process-tool-provider — barrel contract', () => {
  it('Test 14 — InProcessToolProvider is exported as a constructor', () => {
    expect(typeof mod.InProcessToolProvider).toBe('function');
    const p = new mod.InProcessToolProvider({ tools: [] });
    expect(p.id).toBe('in-process');
  });

  it('Test 15 — runtime ToolProvider satisfies (compile + runtime check)', () => {
    const p = new InProcessToolProvider({ tools: [] });
    // Compile-time: type assignability.
    const _typecheck: ToolProvider = p;
    void _typecheck;
    // Runtime: shape assertions.
    expect('id' in p).toBe(true);
    expect(typeof p.describeTools).toBe('function');
    expect(typeof p.executeTool).toBe('function');
  });

  it('Test 16 — defineInProcessTool exported as a function', () => {
    expect(typeof mod.defineInProcessTool).toBe('function');
    expect(defineInProcessTool).toBe(mod.defineInProcessTool);
  });

  it('Test 17 — barrel does NOT re-export error classes (PATTERNS discipline)', () => {
    // Error classes live in @kagent/agent-loop — single source of truth for instanceof.
    expect('ToolProviderError' in mod).toBe(false);
    expect('InvalidConfigError' in mod).toBe(false);
    expect('HttpToolProviderNetworkError' in mod).toBe(false);
  });

  it('Test 18 — barrel does NOT export scaffold placeholders', () => {
    expect('SCAFFOLD_VERSION' in mod).toBe(false);
  });
});
