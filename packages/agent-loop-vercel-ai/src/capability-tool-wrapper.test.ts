/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 6 — `wrapToolWithCapabilityCheck`.
 *
 * R3 §4.1 requires: cap wrapper denies tool execute when claim
 * missing.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CapabilityBundle } from '@kagent/capability-types';
import { tool } from 'ai';
import { z } from 'zod';

import { wrapToolWithCapabilityCheck } from './capability-tool-wrapper.js';

function makeBundle(claims: CapabilityBundle['claims']): CapabilityBundle {
  return {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task:test',
    aud: ['kagent.substrate.v1'],
    exp: 9_999_999_999,
    jti: 'cap-test',
    claims,
  };
}

describe('wrapToolWithCapabilityCheck', () => {
  it('returns the tool unchanged when there is no inner execute', () => {
    const t = tool({
      description: 'no-op',
      inputSchema: z.object({}),
      // no execute
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: makeBundle({ tools: ['*'], tenant: 't' }),
      category: 'tools',
      target: 'foo',
    });
    expect(wrapped).toBe(t);
  });

  it('refuses when target is not admitted by claims', async () => {
    const inner = vi.fn(() => Promise.resolve('ok'));
    const t = tool({
      description: 'gated',
      inputSchema: z.object({ agentName: z.string() }),
      execute: inner,
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: makeBundle({ spawn: ['summarizer-*'], tenant: 't' }),
      category: 'spawn',
      target: (input) => input.agentName,
    });
    await expect(
      (wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        { agentName: 'researcher-1' },
        {},
      ),
    ).rejects.toThrow(/policy_denied:capability_violation/);
    expect(inner).not.toHaveBeenCalled();
  });

  it('admits when target matches a glob in claims', async () => {
    const inner = vi.fn(() => Promise.resolve('ok'));
    const t = tool({
      description: 'gated',
      inputSchema: z.object({ agentName: z.string() }),
      execute: inner,
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: makeBundle({ spawn: ['summarizer-*'], tenant: 't' }),
      category: 'spawn',
      target: (input) => input.agentName,
    });
    const result = await (wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { agentName: 'summarizer-7' },
      {},
    );
    expect(result).toBe('ok');
    expect(inner).toHaveBeenCalledOnce();
  });

  it('refuses when bundle is undefined and requireBundle is true (default)', async () => {
    const inner = vi.fn(() => Promise.resolve('ok'));
    const t = tool({
      description: 'gated',
      inputSchema: z.object({}),
      execute: inner,
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: undefined,
      category: 'tools',
      target: 'foo',
    });
    await expect(
      (wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {}),
    ).rejects.toThrow(/policy_denied:no_capability/);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes through to inner when bundle is undefined and requireBundle is false (legacy)', async () => {
    const inner = vi.fn(() => Promise.resolve('ok'));
    const t = tool({
      description: 'legacy',
      inputSchema: z.object({}),
      execute: inner,
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: undefined,
      category: 'tools',
      target: 'foo',
      requireBundle: false,
    });
    const result = await (wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe('ok');
    expect(inner).toHaveBeenCalledOnce();
  });

  it('skips the gate when target deriver returns undefined', async () => {
    const inner = vi.fn(() => Promise.resolve('ok'));
    const t = tool({
      description: 'optional-target',
      inputSchema: z.object({}),
      execute: inner,
    });
    const wrapped = wrapToolWithCapabilityCheck(t, {
      bundle: makeBundle({ tools: [], tenant: 't' }),
      category: 'tools',
      target: () => undefined,
    });
    await (wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
    expect(inner).toHaveBeenCalledOnce();
  });
});
