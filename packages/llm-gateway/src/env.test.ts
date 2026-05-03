/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('parses minimal required env (DATABASE_URL + ADMIN_API_TOKEN)', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok-123',
    });
    expect(cfg.databaseUrl).toBe('postgres://u:p@h:5432/d');
    expect(cfg.adminApiToken).toBe('tok-123');
    expect(cfg.port).toBe(4000);
    expect(cfg.backendTimeoutMs).toBe(60000);
    expect(cfg.modelEndpointNamespace).toBe('kagent-system');
  });

  it('parses optional overrides', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok-123',
      PORT: '5555',
      BACKEND_TIMEOUT_MS: '15000',
      MODEL_ENDPOINT_NAMESPACE: 'gateway-ns',
    });
    expect(cfg.port).toBe(5555);
    expect(cfg.backendTimeoutMs).toBe(15000);
    expect(cfg.modelEndpointNamespace).toBe('gateway-ns');
  });

  it('throws when DATABASE_URL missing', () => {
    expect(() => parseEnv({ ADMIN_API_TOKEN: 'tok' })).toThrow(/DATABASE_URL/);
  });

  it('throws when ADMIN_API_TOKEN missing', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/ADMIN_API_TOKEN/);
  });

  it('throws when PORT not numeric', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgres://x', ADMIN_API_TOKEN: 'tok', PORT: 'oops' }),
    ).toThrow(/PORT/);
  });

  it('throws when PORT out of range', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgres://x', ADMIN_API_TOKEN: 'tok', PORT: '70000' }),
    ).toThrow(/PORT/);
  });

  it('throws when BACKEND_TIMEOUT_MS not positive', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://x',
        ADMIN_API_TOKEN: 'tok',
        BACKEND_TIMEOUT_MS: '-1',
      }),
    ).toThrow(/BACKEND_TIMEOUT_MS/);
  });
});
