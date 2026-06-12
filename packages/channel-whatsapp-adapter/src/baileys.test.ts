/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { createBaileysSocketFactory } from './baileys.js';

const makeSocket = vi.fn((_options: Record<string, unknown>) => ({
  ev: { on: vi.fn() },
}));
const saveCreds = vi.fn();

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeSocket,
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: 'state' },
    saveCreds,
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 1] }),
}));

describe('createBaileysSocketFactory', () => {
  it('passes a silent logger so Baileys does not emit pairing internals', async () => {
    await createBaileysSocketFactory()({ authDir: '/auth' });

    const options = makeSocket.mock.calls[0]?.[0];
    expect(options).toMatchObject({ printQRInTerminal: false });
    const logger = asRecord(options?.logger);
    expect(logger?.level).toBe('silent');
    expect(typeof logger?.info).toBe('function');
    expect(typeof logger?.warn).toBe('function');
    expect(typeof logger?.error).toBe('function');
    expect(typeof logger?.child).toBe('function');
    expect((logger?.child as (() => unknown) | undefined)?.()).toBe(logger);
  });
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
