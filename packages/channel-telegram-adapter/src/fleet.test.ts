/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { stripPreviousTurn, withPreviousTurn } from './brain.js';
import {
  fetchFleetNow,
  fleetSnapshot,
  recordRule,
  renderFleetNow,
  renderRuleRecord,
  ruleIn,
  withFleetNow,
} from './fleet.js';

const payload = {
  fleet: {
    health: {
      summary: 'Fleet health: nothing is broken. Of the last 5 runs, 3 shipped.',
      computed_at: '2026-09-09T18:00:00Z',
      memory: { by_source: { claude: 28, chris: 2, dream: 3, review: 5 } },
    },
    memory:
      'WHAT WE HAVE LEARNED (read before acting):\n- [feedback, all repos] Never route inference to the cloud.\n- [feedback, all repos] Say what you did and what you did not do.\n- [lesson, o/r] npm reads overrides, not resolutions.',
  },
};

describe('fleet now', () => {
  it('reduces the launcher payload to the summary, the memory counts and the rules', () => {
    const snap = fleetSnapshot(payload);
    expect(snap?.summary).toContain('nothing is broken');
    expect(snap?.rules).toEqual([
      'Never route inference to the cloud.',
      'Say what you did and what you did not do.',
    ]);
    const block = renderFleetNow(snap!);
    expect(block.startsWith('[fleet now]\nFleet health: nothing is broken.')).toBe(true);
    expect(block).toContain(
      "memory rows by author: chris 2, claude 28, dream 3, review 5 (chris and claude are the mentors' seed",
    );
    expect(block).toContain('- Never route inference to the cloud.');
  });

  it('rides inside the previous-turn bridge and strips back to the raw message either way', () => {
    const block = '[fleet now]\nFleet health: nothing is broken.';
    const plain = withFleetNow('Status?', block);
    expect(plain).toBe('[fleet now]\nFleet health: nothing is broken.\n[current message]\nStatus?');
    expect(stripPreviousTurn(plain)).toBe('Status?');
    const bridged = withFleetNow(
      withPreviousTurn({
        text: 'and now?',
        previousMessage: 'Status?',
        previousReply: 'fine',
        operatorName: 'Chris',
      }),
      block,
    );
    expect(bridged).toBe(
      '[previous turn]\nChris: Status?\nYou: fine\n[fleet now]\nFleet health: nothing is broken.\n[current message]\nand now?',
    );
    expect(stripPreviousTurn(bridged)).toBe('and now?');
  });

  it('fetches /missions and returns nothing when the launcher is silent or empty', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await fetchFleetNow('http://launcher:8080/', ok as unknown as typeof fetch)).toContain(
      '[fleet now]',
    );
    expect(ok).toHaveBeenCalledWith('http://launcher:8080/missions', expect.anything());
    const down = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    expect(
      await fetchFleetNow('http://launcher:8080', down as unknown as typeof fetch),
    ).toBeUndefined();
    const empty = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ fleet: {} }), { status: 200 }));
    expect(
      await fetchFleetNow('http://launcher:8080', empty as unknown as typeof fetch),
    ).toBeUndefined();
  });
});

describe('rule capture', () => {
  it('ruleIn takes only a message that starts with rule: or remember:', () => {
    expect(ruleIn('rule: never delete a fleet job\n on an unchecked clock')).toBe(
      'never delete a fleet job on an unchecked clock',
    );
    expect(ruleIn('  Remember : ask before merging')).toBe('ask before merging');
    expect(ruleIn('what is the rule: here?')).toBeUndefined();
    expect(ruleIn('rule: ok')).toBeUndefined(); // too short to be one
  });

  it('recordRule posts to /remember and reports the outcome truthfully', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const okFetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, post: 42 }), { status: 201 }));
    }) as unknown as typeof fetch;
    expect(await recordRule('http://launcher/', 'ask first', okFetch)).toEqual({
      ok: true,
      post: 42,
    });
    expect(calls).toEqual([
      { url: 'http://launcher/remember', body: { text: 'ask first', ref: 'telegram' } },
    ]);
    const down = (() =>
      Promise.resolve(new Response('no', { status: 503 }))) as unknown as typeof fetch;
    const r = await recordRule('http://launcher', 'ask first', down);
    expect(r).toEqual({ ok: false, error: 'launcher answered HTTP 503' });
    expect(renderRuleRecord('ask first', r)).toContain('could NOT record');
    expect(renderRuleRecord('ask first', { ok: true, post: 42 })).toContain('forum post 42');
  });
});
