/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Auth middleware integration tests against the composed router.
 *
 * Covers WS-A acceptance criteria:
 *   - auth required, header present → 200
 *   - auth required, header missing → 401
 *   - auth disabled, header missing → 200
 *   - /healthz always 200, regardless of auth
 */

import { describe, expect, it } from 'vitest';

import { resolveAuthRequired } from './auth.js';
import { SnapshotCache } from './cache.js';
import { buildRouter } from './router.js';
import { SseBroker } from './sse.js';

function buildAppWithAuth(required: boolean) {
  const cache = new SnapshotCache();
  const broker = new SseBroker(cache);
  return buildRouter({
    cache,
    broker,
    ready: () => true,
    authRequired: required,
  });
}

describe('resolveAuthRequired — fail-closed env policy', () => {
  it('returns true when env var is unset', () => {
    expect(resolveAuthRequired({})).toBe(true);
  });

  it('returns true when env var is empty string', () => {
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: '' })).toBe(true);
  });

  it('returns true for "true" / arbitrary values (only literal "false" disables)', () => {
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: 'true' })).toBe(true);
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: '0' })).toBe(true);
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: 'no' })).toBe(true);
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: 'False' })).toBe(true);
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: 'FALSE' })).toBe(true);
  });

  it('returns false ONLY for the exact literal "false"', () => {
    expect(resolveAuthRequired({ WORKBENCH_AUTH_REQUIRED: 'false' })).toBe(false);
  });
});

describe('buildRouter — auth required (default)', () => {
  it('returns 200 when X-Forwarded-User is present on /api/tasks', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/api/tasks', {
      headers: { 'X-Forwarded-User': 'alice@example.com' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 when X-Forwarded-User is missing on /api/tasks', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unauthenticated');
    expect(body.reason).toMatch(/X-Forwarded-User/);
  });

  it('returns 401 when X-Forwarded-User is whitespace-only', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/api/tasks', {
      headers: { 'X-Forwarded-User': '   ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 on /api/agents when header is missing', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/api/agents');
    expect(res.status).toBe(401);
  });

  it('returns 200 on /api/agents when header is present', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/api/agents', {
      headers: { 'X-Forwarded-User': 'alice' },
    });
    expect(res.status).toBe(200);
  });
});

describe('buildRouter — auth disabled', () => {
  it('returns 200 on /api/tasks even with no header', async () => {
    const app = buildAppWithAuth(false);
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(200);
  });

  it('still threads X-Forwarded-User through when present (no rejection)', async () => {
    const app = buildAppWithAuth(false);
    const res = await app.request('/api/tasks', {
      headers: { 'X-Forwarded-User': 'alice' },
    });
    expect(res.status).toBe(200);
  });
});

describe('buildRouter — probe exemption', () => {
  it('/healthz is 200 with auth required and no header', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('/healthz is 200 with auth disabled', async () => {
    const app = buildAppWithAuth(false);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('/readyz is 200 with auth required and no header (when ready)', async () => {
    const app = buildAppWithAuth(true);
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
  });
});
