/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import * as mod from './index.js';
import { HttpToolProvider } from './index.js';
import type { HttpToolProviderOptions, HttpToolDefinition } from './index.js';
import type { ToolProvider } from '@kagent/agent-loop';

describe('@ctkadvisors/http-tool-provider — barrel contract', () => {
  it('Test 14 — HttpToolProvider is exported as a constructor', () => {
    expect(typeof mod.HttpToolProvider).toBe('function');
    const p = new mod.HttpToolProvider({ tools: [] });
    expect(p.id).toBe('http');
  });

  it('Test 15 — runtime ToolProvider satisfies (compile + runtime check)', () => {
    const p = new HttpToolProvider({ tools: [] });
    // Compile-time: type assignability.
    const _typecheck: ToolProvider = p;
    void _typecheck;
    // Runtime: shape assertions.
    expect('id' in p).toBe(true);
    expect(typeof p.describeTools).toBe('function');
    expect(typeof p.executeTool).toBe('function');
  });

  it('Test 16 — barrel exports the HttpToolProviderOptions + HttpToolDefinition types', () => {
    // Type-only assertion — proves the types are exported. If absent, tsc
    // fails compile.
    const opts: HttpToolProviderOptions = { tools: [] };
    expect(Array.isArray(opts.tools)).toBe(true);
    const def: HttpToolDefinition = {
      name: 't',
      description: 'd',
      inputSchema: {},
      method: 'GET',
      path: '/x',
    };
    expect(def.method).toBe('GET');
  });

  it('Test 17 — barrel does NOT re-export error classes (PATTERNS discipline)', () => {
    // Error classes live in @kagent/agent-loop — single source of truth for instanceof.
    expect('ToolProviderError' in mod).toBe(false);
    expect('HttpToolProviderNetworkError' in mod).toBe(false);
    expect('HttpToolProviderConfigError' in mod).toBe(false);
    expect('InvalidConfigError' in mod).toBe(false);
  });

  it('Test 18 — barrel does NOT export scaffold placeholders', () => {
    expect('SCAFFOLD_VERSION' in mod).toBe(false);
  });
});
