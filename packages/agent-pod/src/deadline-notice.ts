/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tells a running agent when its wall-clock limit is near.
 *
 * The pod enforces `runConfig.timeoutSeconds` (runner.ts) but the model
 * never saw the clock, so it budgeted by turns. Read on the homelab
 * 2026-11-21: two four-hour builder runs had nothing committed with
 * 20 and 40 minutes left, and four tasks that day ended on "task time
 * limit reached" with their work unposted. A sentence in the task
 * message at turn 0 did not change that; this puts the remaining time
 * on a tool reply when it matters, once at 75% and once at 90%.
 */

import type { ToolProvider, ToolResult } from '@kagent/agent-loop';

const THRESHOLDS = [0.75, 0.9] as const;

export interface DeadlineNotice {
  /** Start the clock. Until armed, tool replies pass through untouched. */
  arm(startedAtMs: number, timeoutMs: number): void;
  wrap(providers: readonly ToolProvider[]): ToolProvider[];
}

export function createDeadlineNotice(clock: () => number = Date.now): DeadlineNotice {
  let startedAtMs: number | undefined;
  let timeoutMs = 0;
  let announced = 0; // how many THRESHOLDS have been announced

  const pending = (): string | undefined => {
    if (startedAtMs === undefined || timeoutMs <= 0) return undefined;
    const fraction = (clock() - startedAtMs) / timeoutMs;
    let crossed = announced;
    while (crossed < THRESHOLDS.length && fraction >= (THRESHOLDS[crossed] ?? 1)) crossed += 1;
    if (crossed === announced) return undefined;
    announced = crossed;
    const minutes = Math.max(0, Math.floor((startedAtMs + timeoutMs - clock()) / 60_000));
    return (
      `[Run time notice: about ${String(minutes)} minute(s) remain before this task is stopped ` +
      `at its time limit (${String(Math.round(timeoutMs / 1000))} s). Work that exists only in a ` +
      'sandbox or in this conversation is lost then: save, commit or post what must outlive ' +
      'the run, and give any child task less time than remains.]'
    );
  };

  const annotate = (result: ToolResult): ToolResult => {
    const notice = pending();
    if (notice === undefined) return result;
    return typeof result.content === 'string'
      ? { ...result, content: `${notice}\n\n${result.content}` }
      : { ...result, content: [{ type: 'text', text: notice }, ...result.content] };
  };

  return {
    arm(started, timeout) {
      startedAtMs = started;
      timeoutMs = timeout;
    },
    wrap: (providers) =>
      providers.map((provider) => ({
        id: provider.id,
        describeTools: (ctx) => provider.describeTools(ctx),
        executeTool: async (call, ctx) => annotate(await provider.executeTool(call, ctx)),
      })),
  };
}
