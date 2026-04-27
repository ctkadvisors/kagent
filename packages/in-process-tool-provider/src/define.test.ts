/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import { defineInProcessTool } from './define.js';
import type { InProcessToolDefinition } from './provider.js';

describe('defineInProcessTool', () => {
  it('returns the input definition verbatim (identity helper)', () => {
    const def: InProcessToolDefinition = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object' },
      handler: () => 'ok',
    };
    expect(defineInProcessTool(def)).toBe(def);
  });

  it('preserves optional tags field', () => {
    const def: InProcessToolDefinition = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object' },
      handler: () => 'ok',
      tags: ['tag1', 'tag2'],
    };
    const result = defineInProcessTool(def);
    expect(result.tags).toEqual(['tag1', 'tag2']);
  });
});
