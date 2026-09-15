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
      memory: {
        by_source: { claude: 28, chris: 2, dream: 3, review: 5 },
        recent: [
          {
            source: 'dream',
            at: '2026-09-09',
            text: 'A run that pushes to the fixture origin looks like no commit.',
          },
        ],
      },
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
    expect(snap?.recent).toEqual([
      {
        source: 'dream',
        at: '2026-09-09',
        text: 'A run that pushes to the fixture origin looks like no commit.',
      },
    ]);
    expect(block).toContain('written by the fleet itself lately (these are all of them');
    expect(block).toContain(
      '- [dream 2026-09-09] A run that pushes to the fixture origin looks like no commit.',
    );
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
      '[earlier in this conversation]\nChris: Status?\nYou: fine\n[fleet now]\nFleet health: nothing is broken.\n[current message]\nand now?',
    );
    expect(stripPreviousTurn(bridged)).toBe('and now?');
  });

  it('fetches /missions and returns the block when the launcher answers, or absent', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const hit = await fetchFleetNow('http://launcher:8080/', ok);
    expect(hit.kind).toBe('rendered');
    expect(hit.kind === 'rendered' && hit.block).toContain('[fleet now]');
    expect(ok).toHaveBeenCalledWith('http://launcher:8080/missions', expect.anything());
    const empty = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ fleet: {} }), { status: 200 }));
    const silent = await fetchFleetNow('http://launcher:8080', empty);
    expect(silent.kind).toBe('absent');
  });

  it('reports a stale launcher (non-2xx or unreachable) instead of returning nothing', async () => {
    const down = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const stale = await fetchFleetNow('http://launcher:8080', down);
    expect(stale.kind).toBe('stale');
    if (stale.kind === 'stale') expect(stale.reason).toContain('HTTP 503');

    const timesOut = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new DOMException('Aborted', 'TimeoutError');
    }) as unknown as typeof fetch;
    const aborted = await fetchFleetNow('http://launcher:8080', timesOut, 1);
    expect(aborted.kind).toBe('stale');
    if (aborted.kind === 'stale') expect(aborted.reason).toContain('Aborted');
  });

  it('treats a 200 body the launcher cannot parse as stale, not a rejection', async () => {
    // A 200 HTML/error body: JSON.parse throws inside fleetSnapshot(await json()).
    const html = vi.fn().mockResolvedValue(new Response('<html>500</html>', { status: 200 }));
    const result = await fetchFleetNow('http://launcher:8080', html);
    expect(result.kind).toBe('stale');
    if (result.kind === 'stale') {
      expect(result.reason).toContain('unparseable');
      expect(result.reason).not.toContain('\n');
    }
  });

  it('sanitises a multiline launcher reason to one line', async () => {
    // A fetch that throws synchronously (e.g. unreachable host) reaches the
    // catch block; a generous timeout keeps AbortSignal from firing first and
    // replacing the reason with its own single-line message. The point is the
    // collapse: every newline is dropped, leaving just the first line.
    const multiLine = (async () =>
      Promise.reject(new Error('line one\n  line two\twith tabs'))) as unknown as typeof fetch;
    const result = await fetchFleetNow('http://launcher:8080', multiLine, 1000);
    expect(result.kind).toBe('stale');
    if (result.kind === 'stale') {
      expect(result.reason).toBe('line one');
      expect(result.reason).not.toContain('\n');
    }
  });

  it('never leaves a blank launcher reason empty in the stale line', async () => {
    // An error whose message is whitespace would otherwise surface as
    // "launcher fetch failed ()" in the user-visible stale line; the guard
    // substitutes a neutral marker instead.
    const blank = (async () => Promise.reject(new Error('   '))) as unknown as typeof fetch;
    const result = await fetchFleetNow('http://launcher:8080', blank, 1000);
    expect(result.kind).toBe('stale');
    if (result.kind === 'stale') {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).not.toMatch(/^\s*$/u);
    }
  });
});

describe('fleet now ideas', () => {
  it("lists the archive's active lineages so the concierge knows what the fleet wants to try next", () => {
    const withIdeas = {
      fleet: {
        ...payload.fleet,
        ideas: {
          active: [
            {
              id: 'ea8179ef1b6d',
              lineage: 'ea8179ef1b6d',
              problem: 'The implement stage halts on missing artifacts',
              status: 'active',
              source: 'ideator',
            },
          ],
        },
      },
    };
    const snap = fleetSnapshot(withIdeas);
    expect(snap?.ideas).toEqual([
      {
        id: 'ea8179ef1b6d',
        problem: 'The implement stage halts on missing artifacts',
        status: 'active',
        source: 'ideator',
      },
    ]);
    expect(renderFleetNow(snap!)).toContain(
      '- [idea:ea8179ef1b6d ideator active] The implement stage halts on missing artifacts',
    );
    expect(fleetSnapshot(payload)?.ideas).toEqual([]);
  });
});

describe('fleet now query', () => {
  it('passes the message to the launcher as ?q so the recall matches it', async () => {
    const urls: string[] = [];
    const f = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }) as unknown as typeof fetch;
    await fetchFleetNow('http://launcher', f, 5000, 'what does refresh first mean?');
    expect(urls).toEqual(['http://launcher/missions?q=what%20does%20refresh%20first%20mean%3F']);
    await fetchFleetNow('http://launcher', f, 5000, '  ');
    expect(urls[1]).toBe('http://launcher/missions');
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
