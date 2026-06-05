/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Router-level wiring tests for the kagent Studio Architect mount.
 * Confirms `/api/architect/*` is mounted only when an Architect client
 * is threaded, and is reachable ahead of the `/api/*` not-found reservation.
 */
import { describe, expect, it, vi } from 'vitest';

import { SnapshotCache } from './cache.js';
import { buildRouter } from './router.js';
import { SseBroker } from './sse.js';

const VALID = ['agentSpec:', '  model: m1', '  systemPrompt: do a thing', ''].join('\n');

function base() {
  const cache = new SnapshotCache();
  return { cache, broker: new SseBroker(cache), ready: () => true, authRequired: false };
}

describe('buildRouter — Architect mount', () => {
  it('mounts /api/architect/draft when an architect client is provided', async () => {
    const app = buildRouter({
      ...base(),
      architect: { complete: vi.fn(() => Promise.resolve(VALID)) },
    });
    const res = await app.request('/api/architect/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'a thing' }),
    });
    expect(res.status).toBe(200);
  });

  it('does NOT mount /api/architect when no architect client is provided (404 reservation)', async () => {
    const app = buildRouter(base());
    const res = await app.request('/api/architect/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'a thing' }),
    });
    expect(res.status).toBe(404);
  });
});
