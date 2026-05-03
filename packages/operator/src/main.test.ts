/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildJobSpecOptionsFromEnv } from './main.js';

/**
 * Snapshot/restore the env vars this suite mutates so tests stay
 * isolated. `process.env` is shared global state.
 */
const TOUCHED_VARS = [
  'KAGENT_AGENT_POD_LITELLM_BASE_URL',
  'KAGENT_AGENT_POD_LITELLM_API_KEY',
  'KAGENT_LLM_GATEWAY_BASE_URL',
  'KAGENT_LLM_GATEWAY_API_KEY',
] as const;

let snapshot: Partial<Record<(typeof TOUCHED_VARS)[number], string | undefined>>;

beforeEach(() => {
  snapshot = {};
  for (const k of TOUCHED_VARS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_VARS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

function findEnv(extraEnv: { name: string; value: string }[], name: string): string | undefined {
  return extraEnv.find((e) => e.name === name)?.value;
}

describe('buildJobSpecOptionsFromEnv — LLM endpoint resolution', () => {
  it('forwards KAGENT_AGENT_POD_LITELLM_BASE_URL into spawned-Job env when gateway is unset', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm-studio.local:1234/v1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'lm-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://lm-studio.local:1234/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBe('lm-key');
  });

  it('overrides KAGENT_LITELLM_BASE_URL with the gateway URL when KAGENT_LLM_GATEWAY_BASE_URL is set', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm-studio.local:1234/v1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'lm-key';
    process.env.KAGENT_LLM_GATEWAY_BASE_URL =
      'http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000/v1';
    process.env.KAGENT_LLM_GATEWAY_API_KEY = 'gw-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe(
      'http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000/v1',
    );
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBe('gw-key');
    // Critically: NO duplicate KAGENT_LITELLM_BASE_URL — Kubernetes
    // would reject the pod spec for duplicate env names.
    const baseUrlCount = env.filter((e) => e.name === 'KAGENT_LITELLM_BASE_URL').length;
    expect(baseUrlCount).toBe(1);
    const apiKeyCount = env.filter((e) => e.name === 'KAGENT_LITELLM_API_KEY').length;
    expect(apiKeyCount).toBe(1);
  });

  it('omits the API key entirely when neither litellm nor gateway key is set', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://anon.local/v1';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://anon.local/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });

  it('falls back to gateway URL with no API key when gateway is set without a key', () => {
    process.env.KAGENT_LLM_GATEWAY_BASE_URL = 'http://gw.local/v1';
    // Note: NO gateway API key, NO litellm key.

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://gw.local/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });

  it('omits both when neither litellm nor gateway URL is set', () => {
    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBeUndefined();
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });
});
