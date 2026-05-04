/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Barrel-contract test for `@ctkadvisors/local-trace-sinks`.
 *
 * Locks the public API surface:
 *   - `StdoutSink`, `JsonlFileSink` exported as constructors
 *   - `StdoutSinkOptions`, `JsonlFileSinkOptions` re-exported as types (erased at runtime)
 *   - StdoutSink omits `flush()` and `close()` (CONTEXT D-10 — process.stdout
 *     is line-buffered by Node 22; no explicit drain needed)
 *   - JsonlFileSink HAS `flush()` and `close()` (CONTEXT D-13/D-14 — explicit
 *     lifecycle is consumer-owned)
 *   - Both sinks `satisfies TraceSink` (compile + runtime check)
 *   - NO error classes re-exported (CONTEXT D-25 — consumers import
 *     `InvalidConfigError` from `@kagent/agent-loop`)
 *   - NO Wave 0 SCAFFOLD_VERSION placeholder (cleanup discipline; matches
 *     Phase 5 in-process / http / mcp sibling-package cleanup precedent)
 */

import { describe, it, expect } from 'vitest';
import * as mod from './index.js';
import { StdoutSink, JsonlFileSink } from './index.js';
import type { TraceSink } from '@kagent/agent-loop';

describe('@ctkadvisors/local-trace-sinks — barrel contract', () => {
  it('Test B1 — StdoutSink is exported as a constructor; emit() defined; flush()/close() omitted per D-10', () => {
    expect(typeof mod.StdoutSink).toBe('function');
    const s = new mod.StdoutSink();
    expect(typeof s.emit).toBe('function');
    // CONTEXT D-10: StdoutSink omits flush() and close() because process.stdout
    // writes are line-buffered by Node 22; no explicit drain needed.
    expect((s as { flush?: unknown }).flush).toBeUndefined();
    expect((s as { close?: unknown }).close).toBeUndefined();
  });

  it('Test B2 — JsonlFileSink is exported as a constructor with emit + flush + close per D-13/D-14', () => {
    expect(typeof mod.JsonlFileSink).toBe('function');
    // Construct with a never-emit runId — file is NOT created (lazy open per D-12).
    const j = new mod.JsonlFileSink({
      runId: 'never-emit-runtime-test',
      dir: '/tmp/never-opened',
    });
    expect(typeof j.emit).toBe('function');
    expect(typeof j.flush).toBe('function');
    expect(typeof j.close).toBe('function');
  });

  it('Test B3 — both sinks satisfy TraceSink (compile + runtime)', () => {
    const s = new StdoutSink();
    const j = new JsonlFileSink({
      runId: 'never-emit-runtime-test',
      dir: '/tmp/never-opened',
    });
    // Compile-time assignability — TraceSink requires emit; flush + close optional.
    const _check1: TraceSink = s;
    const _check2: TraceSink = j;
    void _check1;
    void _check2;
    // Runtime shape — emit must be a function on both.
    expect(typeof s.emit).toBe('function');
    expect(typeof j.emit).toBe('function');
  });

  it('Test B4 — barrel does NOT re-export error classes (CONTEXT D-25 — sibling-package discipline)', () => {
    // Error classes live in @kagent/agent-loop — single source of truth for instanceof.
    // Same pattern as Phase 5 in-process / http / mcp provider packages.
    expect('InvalidConfigError' in mod).toBe(false);
    expect('ToolProviderError' in mod).toBe(false);
    expect('LLMClientError' in mod).toBe(false);
    expect('TraceSinkError' in mod).toBe(false);
  });

  it('Test B5 — barrel does NOT export Wave 0 SCAFFOLD_VERSION placeholder (cleanup discipline)', () => {
    // SCAFFOLD_VERSION shipped in Plan 06-01 Wave 0 to prove the package loads;
    // Plan 06-04 flips the barrel to real exports + this test asserts cleanup.
    // Same sentinel-cleanup pattern as Plans 04-06 / 05-04 / 05-05.
    expect('SCAFFOLD_VERSION' in mod).toBe(false);
  });

  it('Test B6 — barrel exports exactly the documented runtime-visible named members', () => {
    // Runtime-visible exports:
    //   3 classes — StdoutSink, JsonlFileSink, OtelTraceSink
    //   7 OTel sink helpers — isOtelEnabled, setupOtelExporter,
    //     traceIdFromRunId, langfuseTraceUrl, plus the v0.1.11 W3C
    //     Trace Context propagation helpers spanIdFromRunId,
    //     buildTraceparentFromRunId, parseTraceparent
    //   2 langfuse-otel-format constants — DEFAULT_CONTENT_MODE, DEFAULT_PREVIEW_CHARS
    //   8 langfuse-otel-format functions — applyContentMode, formatLlmCallAttrs,
    //     formatRootSpanAttrs, formatRunCompleteAttrs, formatToolCallAttrs,
    //     parseContentMode, toLangfuseJsonString, truncatePreservingJson
    // Type-only exports (StdoutSinkOptions, JsonlFileSinkOptions,
    // OtelTraceSinkOptions, ContentMode, RunContext, ParsedTraceparent)
    // are erased at runtime. Adding a new runtime export REQUIRES
    // updating this assertion.
    const runtimeKeys = Object.keys(mod).sort();
    expect(runtimeKeys).toEqual([
      'DEFAULT_CONTENT_MODE',
      'DEFAULT_PREVIEW_CHARS',
      'JsonlFileSink',
      'OtelTraceSink',
      'StdoutSink',
      'applyContentMode',
      'buildTraceparentFromRunId',
      'formatLlmCallAttrs',
      'formatRootSpanAttrs',
      'formatRunCompleteAttrs',
      'formatToolCallAttrs',
      'isOtelEnabled',
      'langfuseTraceUrl',
      'parseContentMode',
      'parseTraceparent',
      'setupOtelExporter',
      'spanIdFromRunId',
      'toLangfuseJsonString',
      'traceIdFromRunId',
      'truncatePreservingJson',
    ]);
  });
});
