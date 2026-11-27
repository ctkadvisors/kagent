/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ChatResult, ToolDescriptor } from '@kagent/agent-loop';
import { describe, expect, it } from 'vitest';

import { recoverTextToolCalls } from './text-tool-calls.js';

/** Final "answers" of real fleet tasks on 2026-11-26, copied from AgentTask.status.result.content. */
const REAL = {
  'code_interpreter|False':
    '<tool_call>\n<function=code_interpreter>\n<parameter=code>\nimport json, os, collections\np="browser-captures/95bb2a56-4a22-47d9-9390-e759f3d7b6ff/page.txt"\nt=open(p, encoding="utf-8").read()\nprint(len(t))\nprint(t[:2000])\n</parameter>\n</function>\n</tool_call>',
  'code_interpreter|True':
    '<tool_call>\n<function=code_interpreter>\n<parameter=execute_code>\n<parameter=language>\npython\n</parameter>\n<parameter=code>\nimport json, os, re\np="browser-captures/d51878fe-55a3-4498-94b5-77c78aeb22d9/page.txt"\nt=open(p,encoding="utf-8").read()\nprint(len(t))\nprint(t[:2000])\n\n</parameter>\n</function>\n</tool_call>',
  'fleet.memory_recall|False':
    "<tool_call>` text \u2014 nothing actually ran. I'll execute real calls from the start.\n\n<tool_call>\n<function=fleet.memory_recall>\n<parameter=q>\ntruncated_synthesis detector quality-flags stop_reason false positives fleet-boss answers\n</parameter>\n<parameter=repository>\nctkadvisors/kagent\n</parameter>\n<parameter=paths>\npackages/agent-loop/src/detectors/quality-flags.ts,packages/agent-loop/src/trace.ts\n</parameter>\n<parameter=budget_chars>\n6000\n</parameter>\n</function>\n</tool_call>",
  'http.task_diagnostics|False':
    '<tool_call>` markup** \u2014 nothing ran. Let me verify that against actual traces and probe live faces.\n\n<tool_call>\n<function=http.task_diagnostics>\n<parameter=namespace>\nkagent-system\n</parameter>\n<parameter=name>\nfleet-nightly-invention-1795719300\n</parameter>\n<parameter=limit>\n10\n</parameter>\n</function>\n</tool_call>',
  'fleet.forum_read|False':
    '<tool_call>` text. Executing for real now.\n\n<tool_call>\n<function=fleet.forum_read>\n<parameter=author>\nfleet-inventor\n</parameter>\n<parameter=limit>\n4\n</parameter>\n</function>\n</tool_call>',
} as Record<string, string>;

const tool = (name: string, properties: Record<string, unknown> = {}): ToolDescriptor => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties },
});
const TOOLS = [
  tool('code_interpreter.execute_code', {
    code: { type: 'string' },
    language: { type: 'string' },
    timeoutMs: { type: 'integer' },
  }),
  tool('fleet.memory_recall', { q: { type: 'string' }, budget_chars: { type: 'integer' } }),
  tool('fleet.forum_read', { author: { type: 'string' }, limit: { type: 'integer' } }),
  tool('http.task_diagnostics', {
    namespace: { type: 'string' },
    name: { type: 'string' },
    limit: { type: 'integer' },
  }),
  tool('write_artifact'),
];
const text = (content: string): ChatResult => ({ content, stopReason: 'end_turn' });
const id = (i: number): string => `c${String(i)}`;

describe('recoverTextToolCalls', () => {
  it('recovers the call the fleet lost 135 times: <function=code_interpreter> for code_interpreter.execute_code', () => {
    const out = recoverTextToolCalls(
      text('Reading the page.\n\n' + REAL['code_interpreter|False']),
      TOOLS,
      id,
    );
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls?.[0]?.name).toBe('code_interpreter.execute_code');
    const args = out.tool_calls?.[0]?.args as { code: string };
    expect(args.code.startsWith('import json, os, collections\n')).toBe(true);
    expect(args.code.endsWith('print(t[:2000])')).toBe(true);
    expect(out.content).toBe('Reading the page.');
    expect(out.stopReason).toBe('tool_use');
  });

  it('recovers the form with the tool name split across function and an empty first parameter', () => {
    const out = recoverTextToolCalls(text(REAL['code_interpreter|True'] ?? ''), TOOLS, id);
    expect(out.tool_calls?.[0]).toMatchObject({ id: 'c0', name: 'code_interpreter.execute_code' });
    const args = out.tool_calls?.[0]?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['code', 'language']);
    expect(args.language).toBe('python');
  });

  it('recovers a correctly named call the engine dropped, with numbers typed by the tool schema', () => {
    const out = recoverTextToolCalls(text(REAL['fleet.forum_read|False'] ?? ''), TOOLS, id);
    expect(out.tool_calls?.[0]).toEqual({
      id: 'c0',
      name: 'fleet.forum_read',
      args: { author: 'fleet-inventor', limit: 4 },
    });
    // the prose before the call stays as the turn's text, including the markup it quoted
    expect(out.content.endsWith('Executing for real now.')).toBe(true);
    const recall = recoverTextToolCalls(text(REAL['fleet.memory_recall|False'] ?? ''), TOOLS, id);
    expect((recall.tool_calls?.[0]?.args as { budget_chars: number }).budget_chars).toBe(6000);
    const diag = recoverTextToolCalls(text(REAL['http.task_diagnostics|False'] ?? ''), TOOLS, id);
    expect(diag.tool_calls?.[0]).toMatchObject({
      name: 'http.task_diagnostics',
      args: { namespace: 'kagent-system', limit: 10 },
    });
  });

  it('recovers several trailing calls and the JSON form', () => {
    const two =
      'Two reads.\n<tool_call>\n<function=fleet.forum_read>\n<parameter=limit>\n2\n</parameter>\n</function>\n</tool_call>\n' +
      '<tool_call>\n{"name": "write_artifact", "arguments": {"name": "a.txt", "content": "x"}}\n</tool_call>';
    const out = recoverTextToolCalls(text(two), TOOLS, id);
    expect(out.tool_calls?.map((c) => [c.id, c.name, c.args])).toEqual([
      ['c0', 'fleet.forum_read', { limit: 2 }],
      ['c1', 'write_artifact', { name: 'a.txt', content: 'x' }],
    ]);
  });

  it('leaves the result alone unless a call for exactly one offered tool ends the message', () => {
    const same = (result: ChatResult, tools: readonly ToolDescriptor[] | undefined = TOOLS) =>
      expect(recoverTextToolCalls(result, tools, id)).toBe(result);
    const call = REAL['code_interpreter|False'] ?? '';
    same(text('A finished answer with no markup.'));
    same(text(call + '\nSo that is what I ran earlier, and here is my answer.')); // quoted, not a call
    same(text(call), []); // no tools offered
    const noTools = text(call);
    expect(recoverTextToolCalls(noTools, undefined, id)).toBe(noTools);
    same(text(call), [tool('fleet.forum_read')]); // nothing it could mean
    same(text(call), [...TOOLS, tool('code_interpreter.read_files')]); // two it could mean
    same(
      text(
        '<tool_call>\n<function=shell.exec>\n<parameter=cmd>\nid\n</parameter>\n</function>\n</tool_call>',
      ),
    ); // not offered
    same(text('<tool_call>\nnot a call at all\n</tool_call>'));
    same(text('<tool_call>\n<function=fleet.forum_read>\n<parameter=limit>\n2')); // cut off mid-call
    // one unresolvable call among several recovers none of them
    same(text(call + '\n<tool_call>\n<function=shell.exec>\n</function>\n</tool_call>'));
    const structured: ChatResult = {
      content: call,
      tool_calls: [{ id: 'x', name: 'write_artifact', args: {} }],
    };
    same(structured); // the engine already parsed a call
  });
});
