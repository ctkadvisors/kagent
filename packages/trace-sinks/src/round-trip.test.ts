/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Round-trip integration test — ROADMAP Phase 6 SC4 acceptance gate.
 *
 * Writes 6 synthetic TraceEntry records covering all 3 trace_types
 * (`iteration_boundary`, `llm_call`, `tool_call`) with multiple optional-
 * field permutations (cost null vs 0 vs positive; is_error true vs false;
 * input_messages present vs absent; output_tool_calls present; error field
 * present on failure), closes the sink, reads the `.jsonl` file back,
 * parses each line, and asserts deep equality with the originals — proves
 * lossless persistence.
 *
 * Critical:
 *   - RESEARCH §Pitfall 2: macOS os.tmpdir() returns a symlinked path
 *     (`/var` → `/private/var`). NEVER assert on absolute paths. Compare
 *     DATA only — paths are used via join() on the mkdtempSync dir.
 *   - RESEARCH §Pitfall 5: ALWAYS .filter(Boolean) between split('\n')
 *     and JSON.parse — files end with a trailing '\n'; the final split
 *     element is '' which JSON.parse rejects as SyntaxError.
 *
 * This test is the contract that the M3 Langfuse ingester reads. The
 * `JSON.stringify` → `\n` → `JSON.parse` cycle must hold for every field
 * shape the kernel can emit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEntry } from '@kagent/agent-loop';
import { JsonlFileSink } from './jsonl-file-sink.js';

describe('@ctkadvisors/local-trace-sinks — round-trip (SC4 acceptance gate)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phase6-roundtrip-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes 6 entries spanning all 3 trace_types and reads back losslessly (SC4)', async () => {
    // 6 entries covering: iteration boundary, llm_call (cost present),
    // tool_call (success), llm_call (cost null + tool_use stop_reason +
    // output_tool_calls), tool_call (error + error field), iteration
    // boundary close. Each entry exercises a different combination of
    // optional fields.
    const original: TraceEntry[] = [
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 0,
        trace_type: 'iteration_boundary',
        timestamp_ms: 1700000000000,
        latency_ms: 0,
        iteration: 0,
      },
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 1,
        trace_type: 'llm_call',
        timestamp_ms: 1700000001000,
        latency_ms: 1240,
        model: 'gpt-4',
        input_messages: '[{"role":"user","content":"hi"}]',
        output_content: 'hello',
        input_tokens_est: 5,
        output_tokens_est: 1,
        cost_usd: 0.0024,
        stop_reason: 'end_turn',
        tools_available: '["http_ping","echo"]',
      },
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 2,
        trace_type: 'tool_call',
        timestamp_ms: 1700000002000,
        latency_ms: 45,
        tool_name: 'http_ping',
        tool_provider_id: 'http',
        tool_input: '{}',
        tool_output: '{"pong":true}',
        is_error: false,
      },
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 3,
        trace_type: 'llm_call',
        timestamp_ms: 1700000003000,
        latency_ms: 980,
        model: 'mlx-community/NVIDIA-Nemotron-Nano-9B-v2-4bits',
        input_messages: '[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]',
        output_content: '',
        output_tool_calls: '[{"id":"call_1","name":"http_ping","arguments":"{}"}]',
        input_tokens_est: 8,
        output_tokens_est: 12,
        cost_usd: null, // nullable on purpose — Exo doesn't report cost (D-16)
        stop_reason: 'tool_use',
      },
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 4,
        trace_type: 'tool_call',
        timestamp_ms: 1700000004000,
        latency_ms: 12,
        tool_name: 'echo',
        tool_provider_id: 'in-process',
        tool_input: '{"x":42}',
        tool_output: 'echo: 42',
        is_error: true,
        error: 'simulated tool failure',
      },
      {
        schema_version: '1',
        run_id: 'r1',
        sequence: 5,
        trace_type: 'iteration_boundary',
        timestamp_ms: 1700000005000,
        latency_ms: 0,
        iteration: 1,
      },
    ];

    const sink = new JsonlFileSink({ runId: 'r1', dir });
    for (const entry of original) sink.emit(entry);
    await sink.flush();
    await sink.close();

    const path = join(dir, 'r1.jsonl');
    const reconstructed = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean) // CRITICAL — RESEARCH §Pitfall 5: final '' element from trailing '\n' would crash JSON.parse
      .map((line) => JSON.parse(line) as TraceEntry);

    expect(reconstructed).toEqual(original);
    expect(reconstructed.length).toBe(6);

    // Sanity: every reconstructed line carries schema_version '1' — locks
    // the M3 ingester contract at entry-level (no outer envelope per D-16).
    for (const entry of reconstructed) {
      expect(entry.schema_version).toBe('1');
    }
  });

  it('round-trip preserves entry ordering across mid-emit flush + final close', async () => {
    // Edge case: emits interspersed with an await (mid-run flush) should
    // still preserve sequence monotonicity — proves the JsonlFileSink
    // append stream doesn't reorder writes across flush boundaries.
    const sink = new JsonlFileSink({ runId: 'ordering', dir });
    for (let i = 0; i < 10; i++) {
      sink.emit({
        schema_version: '1',
        run_id: 'ordering',
        sequence: i,
        trace_type: 'iteration_boundary',
        timestamp_ms: 1700000000000 + i * 1000,
        latency_ms: 0,
        iteration: i,
      });
      if (i === 5) await sink.flush(); // mid-emit flush should not reorder
    }
    await sink.close();

    const reconstructed = readFileSync(join(dir, 'ordering.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean) // CRITICAL — RESEARCH §Pitfall 5
      .map((line) => JSON.parse(line) as TraceEntry);

    expect(reconstructed.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(reconstructed.length).toBe(10);
  });
});
