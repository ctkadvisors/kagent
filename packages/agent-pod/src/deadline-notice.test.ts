/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { ToolInvocationContext, ToolProvider, ToolResult } from '@kagent/agent-loop';
import { createDeadlineNotice } from './deadline-notice.js';

const ctx: ToolInvocationContext = { runId: 'r', abortSignal: new AbortController().signal };
const call = { id: 'c', name: 'echo', arguments: {} };

function provider(content: ToolResult['content']): ToolProvider {
  return {
    id: 'p',
    describeTools: () => [{ name: 'echo', description: 'd', inputSchema: {} }],
    executeTool: () => Promise.resolve({ content, isError: false }),
  };
}

describe('deadline notice', () => {
  it('passes replies through until armed, and before 75% of the limit', async () => {
    let now = 0;
    const notice = createDeadlineNotice(() => now);
    const [wrapped] = notice.wrap([provider('out')]);
    expect((await wrapped!.executeTool(call, ctx)).content).toBe('out');
    notice.arm(0, 1_000_000);
    now = 740_000;
    expect((await wrapped!.executeTool(call, ctx)).content).toBe('out');
    expect(await wrapped!.describeTools()).toHaveLength(1);
  });

  it('says the remaining time once at 75% and once at 90%, on string and block replies', async () => {
    let now = 0;
    const notice = createDeadlineNotice(() => now);
    const [text, blocks] = notice.wrap([provider('out'), provider([{ type: 'text', text: 'b' }])]);
    notice.arm(0, 14_400_000); // four hours

    now = 10_800_000; // 75%: 60 minutes left
    const first = (await text!.executeTool(call, ctx)).content as string;
    expect(first).toMatch(/^\[Run time notice: about 60 minute\(s\) remain/);
    expect(first.endsWith('\n\nout')).toBe(true);
    expect((await text!.executeTool(call, ctx)).content).toBe('out'); // not repeated

    now = 13_000_000; // past 90%: 23 minutes left
    const second = (await blocks!.executeTool(call, ctx)).content;
    expect(second).toHaveLength(2);
    expect((second as { text: string }[])[0]!.text).toContain('about 23 minute(s) remain');
    expect((await blocks!.executeTool(call, ctx)).content).toHaveLength(1);
  });

  it('announces once when a single slow call crosses both marks', async () => {
    let now = 0;
    const notice = createDeadlineNotice(() => now);
    const [wrapped] = notice.wrap([provider('out')]);
    notice.arm(0, 900_000);
    now = 880_000;
    expect((await wrapped!.executeTool(call, ctx)).content).toContain('about 0 minute(s) remain');
    expect((await wrapped!.executeTool(call, ctx)).content).toBe('out');
  });
});
