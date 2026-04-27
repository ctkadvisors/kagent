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
});
