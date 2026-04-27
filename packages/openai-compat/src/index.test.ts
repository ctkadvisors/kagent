/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — barrel export contract tests (VALIDATION row 20).
 */

import { describe, it, expect } from 'vitest';
import { OpenAICompatibleLLMClient } from './index.js';
import type { OpenAICompatibleLLMClientOptions, ToolCallDelta } from './index.js';
import type { LLMClient } from '@kagent/agent-loop';

describe('barrel export contract (VALIDATION row 20)', () => {
  it('VALIDATION.20: exports OpenAICompatibleLLMClient as a class', () => {
    expect(typeof OpenAICompatibleLLMClient).toBe('function');
    expect(OpenAICompatibleLLMClient.prototype).toBeDefined();
  });

  it('VALIDATION.20: OpenAICompatibleLLMClient instance satisfies LLMClient at compile + runtime', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    // Compile-time assertion (tsc fails compile if shape drifts).
    const _typecheck: LLMClient = client;
    void _typecheck;
    // Runtime assertions.
    expect(typeof client.chat).toBe('function');
    expect(typeof client.chatStream).toBe('function');
    expect(typeof client.countTokens).toBe('function');
  });

  it("VALIDATION.20: 'embed' in client === false (D-09 / omit per Claude's Discretion)", () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    expect('embed' in client).toBe(false);
  });

  it('barrel exports the OpenAICompatibleLLMClientOptions type', () => {
    // Type-only assertion — proves the type is exported. If absent,
    // tsc fails compile.
    const opts: OpenAICompatibleLLMClientOptions = {
      baseUrl: 'http://test/v1',
      model: 'm',
    };
    expect(opts.baseUrl).toBe('http://test/v1');
  });

  it('barrel exports the ToolCallDelta type from sse-parser', () => {
    // Type-only assertion — proves ToolCallDelta is re-exported.
    const fragment: ToolCallDelta = {
      index: 0,
      id: 'call_x',
      name: 'get_time',
      args_delta: '{"tz":"UTC"}',
    };
    expect(fragment.index).toBe(0);
  });

  it('barrel does NOT re-export error classes (those live in @kagent/agent-loop)', async () => {
    // Defensive check: make sure we did NOT accidentally re-export the error
    // family from this package (which would create dual-source instanceof
    // ambiguity per PATTERNS §10 drift warning).
    const mod = await import('./index.js');
    expect('LLMClientError' in mod).toBe(false);
    expect('LLMClientHttpError' in mod).toBe(false);
    expect('LLMClientProtocolError' in mod).toBe(false);
    expect('LLMClientAbortError' in mod).toBe(false);
    expect('LLMClientTimeoutError' in mod).toBe(false);
  });

  it('barrel does NOT export the SCAFFOLD_VERSION placeholder (Plan 04-03 → 04-06 cleanup)', async () => {
    const mod = await import('./index.js');
    expect('SCAFFOLD_VERSION' in mod).toBe(false);
  });
});
