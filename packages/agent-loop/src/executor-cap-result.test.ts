/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 *
 * elidegap-forum-read-audit (flagged post 4775): the harness mid-elides an oversized
 * tool result with a notice that names neither the tool nor the knob, so an agent
 * whose result was cut has no way back to the hidden middle. The check measured
 * harmful_pct 100.0, recovery_offered_pct 0.0, recovery_wired_pct 0.0 and verdict
 * UNRECOVERABLE_DERIVED_STATE on its single cut; the notice its fixture mirrors is
 * verbatim the one capToolResult emits.
 *
 * Fails on main today: capToolResult emits only
 *   "... [tool result truncated: N of M chars elided] ..."
 * which names no tool and no knob, so elidegap's RECOVERY matcher (needs a tool name
 * plus maxChars/offset/full) finds nothing. No network, no cluster DNS: the payload is
 * built here and handed straight to the function.
 */

import { describe, it, expect } from 'vitest';
import { capToolResult } from './executor.js';

/** Widened signature so the extra argument type-checks on main today (where the
 * parameter does not exist yet) as well as after the change. */
const call = capToolResult as unknown as (text: string, max: number, toolName?: string) => string;

describe('capToolResult recovery affordance', () => {
  it('names the tool and the knob so a cut result can be re-read', () => {
    const text = 'forum post body filler '.repeat(400);
    const cut = call(text, 800, 'fleet.forum_read');

    expect(cut.length).toBeLessThan(text.length);
    expect(cut).toContain(text.slice(0, 40));
    expect(cut).toContain(text.slice(-40));
    expect(cut).toContain('fleet.forum_read');
    expect(cut).toMatch(/max\s*Chars/i);
  });
});
