/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Coverage for the four run-end quality-flag detectors. Each test
 * mirrors a real failure mode observed during the 2026-04-26 chat flex
 * (see docs/HARNESS-LESSONS.md).
 */

import { describe, expect, it } from 'vitest';

import type { RunBudget } from '../executor.js';
import type { TraceEntry } from '../trace.js';
import { computeQualityFlags } from './quality-flags.js';

function llm(out: number, content: string, sequence = 1): TraceEntry {
  return {
    schema_version: '1',
    run_id: 'r1',
    sequence,
    trace_type: 'llm_call',
    timestamp_ms: 0,
    latency_ms: 100,
    output_tokens_est: out,
    output_content: content,
  };
}
function tool(
  name: string,
  input: string,
  output: string,
  isError = false,
  sequence = 2,
): TraceEntry {
  return {
    schema_version: '1',
    run_id: 'r1',
    sequence,
    trace_type: 'tool_call',
    timestamp_ms: 0,
    latency_ms: 50,
    tool_name: name,
    tool_input: input,
    tool_output: output,
    is_error: isError,
  };
}
function boundary(iteration: number, sequence: number): TraceEntry {
  return {
    schema_version: '1',
    run_id: 'r1',
    sequence,
    trace_type: 'iteration_boundary',
    timestamp_ms: 0,
    latency_ms: 0,
    iteration,
  };
}
function budget(
  cumulativeInputTokens: number,
  cumulativeOutputTokens: number,
  contextWindowTokens?: number,
): RunBudget {
  return {
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUsd: null,
    ...(contextWindowTokens !== undefined && { contextWindowTokens }),
  };
}

describe('computeQualityFlags', () => {
  it('clean run returns empty flag list', () => {
    const traces: TraceEntry[] = [
      tool(
        'web_search',
        '{"query":"k3s"}',
        '[search results with containerd, k3s, kubernetes…]'.repeat(20),
      ),
      llm(
        50,
        'K3s uses containerd by default. According to the search results from kubernetes.io.',
        3,
      ),
    ];
    expect(
      computeQualityFlags(
        traces,
        'K3s uses containerd by default. According to the search results from kubernetes.io.',
        'what is k3s default runtime?',
      ),
    ).toEqual([]);
  });

  describe('synthesis_low_yield', () => {
    it('flags when ALL delegate_to_agent calls errored', () => {
      const traces: TraceEntry[] = [
        tool(
          'delegate_to_agent',
          '{"agent_type":"x","task":"do X"}',
          '{"error":"sub_agent_refused"}',
          true,
        ),
      ];
      const flags = computeQualityFlags(
        traces,
        'I asked the specialist and got a great answer about X.',
        'analyze X',
      );
      expect(flags).toContain('synthesis_low_yield');
    });

    it('does NOT flag when one delegation succeeded among errors', () => {
      const traces: TraceEntry[] = [
        tool('delegate_to_agent', '{}', 'err1', true),
        tool(
          'delegate_to_agent',
          '{}',
          'real synthesis content from sub-agent agent agent containerd kubernetes'.repeat(8),
          false,
          3,
        ),
      ];
      const flags = computeQualityFlags(
        traces,
        'short synth mentioning containerd kubernetes',
        'foo',
      );
      expect(flags).not.toContain('synthesis_low_yield');
    });
  });

  describe('methodology_fabrication', () => {
    it('flags "I fetched X" claim when only web_search ran', () => {
      const traces: TraceEntry[] = [
        tool(
          'web_search',
          '{"query":"k3s"}',
          'snippet results with containerd kubernetes'.repeat(20),
        ),
        llm(80, 'I fetched the page at https://example.com and the answer is containerd.', 3),
      ];
      const flags = computeQualityFlags(
        traces,
        'I fetched the page at https://example.com and the answer is containerd.',
        'what runtime?',
      );
      expect(flags).toContain('methodology_fabrication');
    });

    it('does NOT flag when fetch_url actually ran', () => {
      const traces: TraceEntry[] = [
        tool('fetch_url', '{"url":"https://x"}', 'page content body'.repeat(20)),
        llm(80, 'I fetched the page and the answer is X.', 3),
      ];
      const flags = computeQualityFlags(traces, 'I fetched the page and the answer is X.', 'foo');
      expect(flags).not.toContain('methodology_fabrication');
    });

    it('flags "I executed the code" with no code-exec tool available', () => {
      const traces: TraceEntry[] = [
        llm(50, 'I executed the python script and the output was 2870.', 1),
      ];
      const flags = computeQualityFlags(
        traces,
        'I executed the python script and the output was 2870.',
        'run print(...)',
      );
      expect(flags).toContain('methodology_fabrication');
    });

    it('flags "I asked the specialist" when no delegate_to_agent fired', () => {
      const traces: TraceEntry[] = [
        tool('list_agents', '{}', 'agent registry stuff'.repeat(20)),
        llm(50, 'I asked the research specialist and the answer is foo.', 3),
      ];
      const flags = computeQualityFlags(
        traces,
        'I asked the research specialist and the answer is foo.',
        'foo',
      );
      expect(flags).toContain('methodology_fabrication');
    });
  });

  describe('tool_use_omission', () => {
    it('flags "cite a real URL" prompt with no fetch/search', () => {
      const traces: TraceEntry[] = [
        tool('list_agents', '{}', 'registry'.repeat(20)),
        llm(80, 'Cloudflare is fast and Strands is good.', 3),
      ];
      const flags = computeQualityFlags(
        traces,
        'Cloudflare is fast and Strands is good.',
        'compare CF Agents and Strands. cite real URLs.',
      );
      expect(flags).toContain('tool_use_omission');
    });

    it('does NOT flag when web_search satisfies "cite real URL" demand', () => {
      const traces: TraceEntry[] = [
        tool('web_search', '{"query":"x"}', 'results'.repeat(20)),
        llm(50, 'Per https://example.com, …', 3),
      ];
      const flags = computeQualityFlags(
        traces,
        'Per https://example.com, …',
        'compare X. cite a real URL.',
      );
      expect(flags).not.toContain('tool_use_omission');
    });

    it('flags "use a research specialist" when no delegate fired', () => {
      const traces: TraceEntry[] = [llm(60, 'Cloudflare is good.', 1)];
      const flags = computeQualityFlags(
        traces,
        'Cloudflare is good.',
        'use a research specialist for this comparison',
      );
      expect(flags).toContain('tool_use_omission');
    });
  });

  describe('truncated_synthesis', () => {
    it('flags non-trivial output that ends mid-sentence', () => {
      const cutContent =
        'Step 1: Understand. Step 2: Analyze. ' +
        'The formula is the n(n+1)(2n+1)/6 expression and we substitute n=20. '.repeat(4) +
        'For n=20 substitute (20)(21)(2*';
      const traces: TraceEntry[] = [llm(256, cutContent, 1)];
      const flags = computeQualityFlags(traces, cutContent, 'compute it');
      expect(flags).toContain('truncated_synthesis');
    });

    it('does NOT flag long content that ends cleanly with punctuation', () => {
      const longClean = 'Long answer that fits and ends with a period. '.repeat(8);
      const traces: TraceEntry[] = [llm(256, longClean, 1)];
      const flags = computeQualityFlags(traces, longClean, 'tell me');
      expect(flags).not.toContain('truncated_synthesis');
    });

    it('does NOT flag short answers (below TRUNCATION_MIN_CONTENT_LEN)', () => {
      const traces: TraceEntry[] = [llm(50, 'containerd', 1)];
      const flags = computeQualityFlags(traces, 'containerd', 'foo');
      expect(flags).not.toContain('truncated_synthesis');
    });

    it('does NOT flag content ending on a markdown link `(url)`', () => {
      const md =
        'Some answer with discussion of the topic and explanations. '.repeat(8) +
        'See [docs](https://example.com/learn-more)';
      const traces: TraceEntry[] = [llm(620, md, 1)];
      const flags = computeQualityFlags(traces, md, 'foo');
      expect(flags).not.toContain('truncated_synthesis');
    });

    it('does NOT flag content ending on a closing bracket', () => {
      const list = 'Discussion paragraph that explains things in detail. '.repeat(8) + '[a, b, c]';
      const traces: TraceEntry[] = [llm(300, list, 1)];
      const flags = computeQualityFlags(traces, list, 'foo');
      expect(flags).not.toContain('truncated_synthesis');
    });

    it('does NOT flag low-output-token runs (below TRUNCATION_MIN_OUTPUT_TOKENS)', () => {
      const longTextLowTokens = 'a '.repeat(200) + 'no terminator here';
      const traces: TraceEntry[] = [llm(40, longTextLowTokens, 1)];
      const flags = computeQualityFlags(traces, longTextLowTokens, 'foo');
      expect(flags).not.toContain('truncated_synthesis');
    });
  });

  it('returns multiple flags when multiple defects compound', () => {
    const compoundContent =
      'I fetched the URL https://x and the answer is some prose that is '.repeat(4) +
      'cut off mid-thought because of the cap';
    const traces: TraceEntry[] = [
      tool('list_agents', '{}', 'registry stuff'.repeat(20)),
      llm(256, compoundContent, 3),
    ];
    const flags = computeQualityFlags(
      traces,
      compoundContent,
      'fetch this page and cite a real URL',
    );
    expect(flags).toContain('methodology_fabrication');
    expect(flags).toContain('tool_use_omission');
    expect(flags).toContain('truncated_synthesis');
  });

  describe('context_pressure_ignored', () => {
    /**
     * Build a 4-iteration trace with a single tool call per iteration.
     * Iteration 0..3 covers the standard "agent did stuff for 4 turns".
     * The last 3 iterations (1, 2, 3) are the lookback window for the
     * default N=3.
     */
    function fourIterTrace(toolNames: readonly [string, string, string, string]): TraceEntry[] {
      const traces: TraceEntry[] = [];
      let seq = 0;
      for (let i = 0; i < 4; i++) {
        traces.push(boundary(i, seq++));
        traces.push(llm(20, 'doing work', seq++));
        traces.push(tool(toolNames[i] ?? 'web_search', '{}', 'result'.repeat(10), false, seq++));
      }
      return traces;
    }

    it('fires when cumulative tokens are past the pressure threshold and no spawn in last N=3 iterations', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      // 750 of 1000 = 0.75 utilization, > 0.7 threshold
      const b = budget(500, 250, 1000);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).toContain('context_pressure_ignored');
    });

    it('does NOT fire when utilization is under the pressure threshold', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      // 600 of 1000 = 0.6 utilization, < 0.7 threshold
      const b = budget(400, 200, 1000);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).not.toContain('context_pressure_ignored');
    });

    it('does NOT fire when the agent self-managed via spawn_child_task in the lookback window', () => {
      // Iteration N-1 (the second-to-last, idx 2) called spawn_child_task.
      const traces = fourIterTrace(['web_search', 'web_search', 'spawn_child_task', 'web_search']);
      const b = budget(500, 250, 1000);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).not.toContain('context_pressure_ignored');
    });

    it('does NOT fire when contextWindowTokens is unset (back-compat)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      // 10000 cumulative but no window declared at all → no-op.
      const b = budget(8000, 2000); // contextWindowTokens unset
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).not.toContain('context_pressure_ignored');
    });

    it('does NOT fire when no budget is provided at all (preserves legacy callsite)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      const flags = computeQualityFlags(traces, 'final answer', 'do work');
      expect(flags).not.toContain('context_pressure_ignored');
    });

    it('fires when the spawn_child_task tool was never admitted (no spawn anywhere in the trace)', () => {
      // Section §4.6 last paragraph: even when the prompt-author never
      // wired spawn_child_task into the agent's tool surface, the
      // detector still fires because the agent has no escape hatch and
      // that's a prompt-author bug worth flagging.
      const traces = fourIterTrace(['web_search', 'fetch_url', 'web_search', 'fetch_url']);
      const b = budget(800, 100, 1000); // 0.9 utilization
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).toContain('context_pressure_ignored');
    });

    it('fires when a spawn_child_task call exists but is OUTSIDE the lookback window', () => {
      // Iteration 0 (oldest) called spawn; iterations 1..3 (the last
      // N=3) had no spawn. Detector should fire.
      const traces = fourIterTrace(['spawn_child_task', 'web_search', 'web_search', 'web_search']);
      const b = budget(500, 250, 1000);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).toContain('context_pressure_ignored');
    });

    it('honors a custom pressureThreshold via opts override', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      // 600/1000 = 0.6 utilization. Below default 0.7, but above 0.5.
      const b = budget(400, 200, 1000);
      const flagsDefault = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flagsDefault).not.toContain('context_pressure_ignored');
      const flagsCustom = computeQualityFlags(traces, 'final answer', 'do work', b, {
        pressureThreshold: 0.5,
      });
      expect(flagsCustom).toContain('context_pressure_ignored');
    });

    it('honors a custom spawnLookbackN — N=1 ignores spawns in older iterations', () => {
      // Iteration 2 spawned (second-to-last). Default N=3 sees it →
      // does NOT fire. With N=1, the lookback only inspects iteration
      // 3 (the last), which has no spawn → fires.
      const traces = fourIterTrace(['web_search', 'web_search', 'spawn_child_task', 'web_search']);
      const b = budget(500, 250, 1000);
      const flagsDefault = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flagsDefault).not.toContain('context_pressure_ignored');
      const flagsTight = computeQualityFlags(traces, 'final answer', 'do work', b, {
        spawnLookbackN: 1,
      });
      expect(flagsTight).toContain('context_pressure_ignored');
    });

    it('does NOT fire when contextWindowTokens is zero (defensive — avoid divide-by-zero)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      const b = budget(500, 250, 0);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flags).not.toContain('context_pressure_ignored');
    });

    /*
     * Audit-rev2 NM4 detector escape — when `spawnToolAdmitted: false`
     * is threaded through opts, the detector skips entirely. This is
     * the "researcher-agent has no spawn admit by design" path —
     * pre-NM4 the detector flooded `structuralVerdict.suspicious[]`
     * with a flag the operator could not tune away. Default-on
     * (`undefined`) preserves the prior behavior for legacy callers.
     */
    it('NM4 escape — does NOT fire when spawnToolAdmitted=false (no escape hatch by design)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      const b = budget(800, 100, 1000); // 0.9 utilization, would normally fire
      const flagsDefault = computeQualityFlags(traces, 'final answer', 'do work', b);
      expect(flagsDefault).toContain('context_pressure_ignored');

      const flagsEscape = computeQualityFlags(traces, 'final answer', 'do work', b, {
        spawnToolAdmitted: false,
      });
      expect(flagsEscape).not.toContain('context_pressure_ignored');
    });

    it('NM4 escape — fires when spawnToolAdmitted=true (explicit opt-in matches default)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      const b = budget(800, 100, 1000);
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b, {
        spawnToolAdmitted: true,
      });
      expect(flags).toContain('context_pressure_ignored');
    });

    it('NM4 escape — undefined spawnToolAdmitted defaults to true (back-compat)', () => {
      const traces = fourIterTrace(['web_search', 'web_search', 'web_search', 'web_search']);
      const b = budget(800, 100, 1000);
      // Pre-NM4 caller — no spawnToolAdmitted field in opts. Behaves
      // identically to setting it to true.
      const flags = computeQualityFlags(traces, 'final answer', 'do work', b, {});
      expect(flags).toContain('context_pressure_ignored');
    });
  });
});
