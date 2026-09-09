/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { stripPreviousTurn, withPreviousTurn } from './brain.js';
import { fetchFleetNow, fleetSnapshot, renderFleetNow, withFleetNow } from './fleet.js';

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
