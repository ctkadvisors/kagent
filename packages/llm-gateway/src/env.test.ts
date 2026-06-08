/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { parseBackendApiKeys, parseDatabaseConn, parseEnv } from './env.js';

describe('parseEnv', () => {
  it('parses minimal required env (DATABASE_URL + ADMIN_API_TOKEN)', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok-123',
    });
    expect(cfg.databaseUrl).toBe('postgres://u:p@h:5432/d');
    expect(cfg.database).toBeNull();
    expect(cfg.adminApiToken).toBe('tok-123');
    expect(cfg.adminApiTokenReadonly).toBeNull();
    expect(cfg.port).toBe(4000);
    expect(cfg.backendTimeoutMs).toBe(60000);
    expect(cfg.modelEndpointNamespace).toBe('kagent-system');
    expect(cfg.backendApiKeys).toEqual({});
  });

  /* =====================================================================
   * M23 — optional read-only admin token. Empty / unset = legacy
   * single-token mode. Whitespace-only is treated as unset. Equality
   * with the full token is rejected at boot (defeats the split).
   * ===================================================================== */

  it('treats absent ADMIN_API_TOKEN_READONLY as null (M23 back-compat)', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok',
    });
    expect(cfg.adminApiTokenReadonly).toBeNull();
  });

  it('treats whitespace-only ADMIN_API_TOKEN_READONLY as null (M23)', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok',
      ADMIN_API_TOKEN_READONLY: '   ',
    });
    expect(cfg.adminApiTokenReadonly).toBeNull();
  });

  it('parses a non-empty ADMIN_API_TOKEN_READONLY (M23)', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'full-tok',
      ADMIN_API_TOKEN_READONLY: 'read-tok',
    });
    expect(cfg.adminApiTokenReadonly).toBe('read-tok');
  });

  it('rejects ADMIN_API_TOKEN_READONLY that equals ADMIN_API_TOKEN (M23 — split defeated)', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://u:p@h:5432/d',
        ADMIN_API_TOKEN: 'same-tok',
        ADMIN_API_TOKEN_READONLY: 'same-tok',
      }),
    ).toThrow(/must NOT equal ADMIN_API_TOKEN/);
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

  it('parses KAGENT_LLM_GATEWAY_PROVIDER_DISPATCH_DISABLED as the hard provider-call kill switch', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok-123',
      KAGENT_LLM_GATEWAY_PROVIDER_DISPATCH_DISABLED: 'true',
    });
    expect(cfg.providerDispatchDisabled).toBe(true);
  });

  it('parses provider failure backoff controls', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok-123',
      KAGENT_LLM_GATEWAY_FAILURE_BACKOFF_THRESHOLD: '2',
      KAGENT_LLM_GATEWAY_FAILURE_BACKOFF_SECONDS: '90',
    });
    expect(cfg.providerFailureBackoffThreshold).toBe(2);
    expect(cfg.providerFailureBackoffSeconds).toBe(90);
  });

  it('throws when neither DATABASE_URL nor split-env is set', () => {
    expect(() => parseEnv({ ADMIN_API_TOKEN: 'tok' })).toThrow(/DATABASE_URL/);
  });

  // Audit B7 — split-credential path
  it('prefers split-env (PG*) over DATABASE_URL when both are set', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      ADMIN_API_TOKEN: 'tok',
      PGHOST: 'pg.svc',
      PGUSER: 'gateway',
      PGPASSWORD: 'sekret',
      PGDATABASE: 'kagent_llm_gateway',
    });
    expect(cfg.databaseUrl).toBeNull();
    expect(cfg.database).toEqual({
      host: 'pg.svc',
      port: 5432,
      user: 'gateway',
      password: 'sekret',
      database: 'kagent_llm_gateway',
      sslMode: 'verify-full',
    });
  });

  it('parses split-env without DATABASE_URL', () => {
    const cfg = parseEnv({
      ADMIN_API_TOKEN: 'tok',
      PGHOST: 'pg.svc',
      PGUSER: 'gateway',
      PGPASSWORD: 'sekret',
      PGDATABASE: 'd',
      PGPORT: '6432',
      PGSSLMODE: 'verify-ca',
      PGSSLROOTCERT: '/etc/ssl/ca.pem',
    });
    expect(cfg.database?.port).toBe(6432);
    expect(cfg.database?.sslMode).toBe('verify-ca');
    expect(cfg.database?.sslRootCertPath).toBe('/etc/ssl/ca.pem');
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

  it('exposes backendApiKeys when BACKEND_API_KEY_* vars are set', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://x',
      ADMIN_API_TOKEN: 'tok',
      BACKEND_API_KEY_CLOUDFLARE: 'cf-secret',
      BACKEND_API_KEY_OPENAI: 'sk-openai',
    });
    expect(cfg.backendApiKeys).toEqual({
      cloudflare: 'cf-secret',
      openai: 'sk-openai',
    });
    // Frozen — substrate config is immutable.
    expect(Object.isFrozen(cfg.backendApiKeys)).toBe(true);
  });
});

describe('parseDatabaseConn (audit B7)', () => {
  it('returns null when no PG* vars are set', () => {
    expect(parseDatabaseConn({})).toBeNull();
  });

  it('returns the full config when all four required vars are set', () => {
    const out = parseDatabaseConn({
      PGHOST: 'pg.svc',
      PGUSER: 'gateway',
      PGPASSWORD: 'sekret',
      PGDATABASE: 'kagent_llm_gateway',
    });
    expect(out).toEqual({
      host: 'pg.svc',
      port: 5432,
      user: 'gateway',
      password: 'sekret',
      database: 'kagent_llm_gateway',
      sslMode: 'verify-full',
    });
  });

  it('throws when split-env is partial (PGHOST without PGPASSWORD)', () => {
    expect(() =>
      parseDatabaseConn({
        PGHOST: 'pg.svc',
        PGUSER: 'gateway',
        PGDATABASE: 'd',
      }),
    ).toThrow(/PGPASSWORD/);
  });

  it('passes through whitespace-bearing PGPASSWORD without trimming', () => {
    // Postgres allows passwords with leading/trailing whitespace; we
    // must not silently mutate them.
    const out = parseDatabaseConn({
      PGHOST: 'pg.svc',
      PGUSER: 'gateway',
      PGPASSWORD: ' my-pwd ',
      PGDATABASE: 'd',
    });
    expect(out?.password).toBe(' my-pwd ');
  });

  it('rejects an unknown PGSSLMODE value', () => {
    expect(() =>
      parseDatabaseConn({
        PGHOST: 'pg.svc',
        PGUSER: 'gateway',
        PGPASSWORD: 'p',
        PGDATABASE: 'd',
        PGSSLMODE: 'tls',
      }),
    ).toThrow(/PGSSLMODE/);
  });
});

describe('parseBackendApiKeys', () => {
  it('returns empty map when no BACKEND_API_KEY_* vars are set', () => {
    expect(parseBackendApiKeys({})).toEqual({});
  });

  it('returns empty map when keys are present but empty strings', () => {
    expect(
      parseBackendApiKeys({
        BACKEND_API_KEY_CLOUDFLARE: '',
        BACKEND_API_KEY_OPENAI: '',
      }),
    ).toEqual({});
  });

  it('parses a single configured backend', () => {
    expect(parseBackendApiKeys({ BACKEND_API_KEY_CLOUDFLARE: 'cf-token' })).toEqual({
      cloudflare: 'cf-token',
    });
  });

  it('parses multiple configured backends', () => {
    expect(
      parseBackendApiKeys({
        BACKEND_API_KEY_CLOUDFLARE: 'cf',
        BACKEND_API_KEY_OPENAI: 'sk',
        BACKEND_API_KEY_ANTHROPIC: 'sk-ant',
        BACKEND_API_KEY_GROQ: 'gsk',
      }),
    ).toEqual({
      cloudflare: 'cf',
      openai: 'sk',
      anthropic: 'sk-ant',
      groq: 'gsk',
    });
  });

  it('trims surrounding whitespace from values', () => {
    // Helm string templating sometimes adds a trailing newline.
    expect(parseBackendApiKeys({ BACKEND_API_KEY_CLOUDFLARE: '  cf-token \n' })).toEqual({
      cloudflare: 'cf-token',
    });
  });

  it('throws when a key is set but contains only whitespace (likely empty Secret)', () => {
    expect(() => parseBackendApiKeys({ BACKEND_API_KEY_CLOUDFLARE: '   \n  ' })).toThrow(
      /BACKEND_API_KEY_CLOUDFLARE/,
    );
  });

  it('ignores unrelated env vars', () => {
    expect(
      parseBackendApiKeys({
        DATABASE_URL: 'postgres://x',
        ADMIN_API_TOKEN: 'tok',
        BACKEND_API_KEY_CLOUDFLARE: 'cf',
        // Looks like a backend key but not in the union — ignored.
        BACKEND_API_KEY_FUTUREPROVIDER: 'whatever',
        // OpenAI SDK auto-loaded var; we deliberately don't read this
        // (chart consumers must use BACKEND_API_KEY_OPENAI explicitly).
        OPENAI_API_KEY: 'leaked-from-sdk',
      }),
    ).toEqual({
      cloudflare: 'cf',
    });
  });

  it('returns a frozen map', () => {
    const out = parseBackendApiKeys({ BACKEND_API_KEY_CLOUDFLARE: 'cf' });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('covers all BackendKind union members', () => {
    // All declared in the BACKEND_API_KEY_ENV_VARS table — guard against
    // a new BackendKind being added to the union without an env entry.
    const out = parseBackendApiKeys({
      BACKEND_API_KEY_OLLAMA: 'a',
      BACKEND_API_KEY_LOCALAI: 'b',
      BACKEND_API_KEY_CLOUDFLARE: 'c',
      BACKEND_API_KEY_OPENAI: 'd',
      BACKEND_API_KEY_ANTHROPIC: 'e',
      BACKEND_API_KEY_BEDROCK: 'f',
      BACKEND_API_KEY_GROQ: 'g',
      BACKEND_API_KEY_EXO: 'h',
      BACKEND_API_KEY_MOCK: 'i',
    });
    expect(Object.keys(out).sort()).toEqual([
      'anthropic',
      'bedrock',
      'cloudflare',
      'exo',
      'groq',
      'localai',
      'mock',
      'ollama',
      'openai',
    ]);
  });
});
