/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const baseEnv: Record<string, string> = {
  KAGENT_TASK_ID: 'task-uid-1',
  KAGENT_TASK_NAME: 't1',
  KAGENT_TASK_NAMESPACE: 'default',
  KAGENT_AGENT_NAME: 'researcher',
  KAGENT_AGENT_SPEC: JSON.stringify({
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    systemPrompt: 'You are a research assistant.',
  }),
  KAGENT_TASK_SPEC: JSON.stringify({
    targetAgent: 'researcher',
    payload: { topic: 'k3s' },
    originalUserMessage: 'what is k3s default runtime?',
  }),
};

describe('parseEnv', () => {
  it('parses a happy-path env into a PodConfig', () => {
    const cfg = parseEnv(baseEnv);
    expect(cfg.taskId).toBe('task-uid-1');
    expect(cfg.taskName).toBe('t1');
    expect(cfg.taskNamespace).toBe('default');
    expect(cfg.agentName).toBe('researcher');
    expect(cfg.agentSpec.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(cfg.agentSpec.systemPrompt).toBe('You are a research assistant.');
    expect(cfg.taskSpec.originalUserMessage).toBe('what is k3s default runtime?');
    expect(cfg.taskSpec.payload).toEqual({ topic: 'k3s' });
  });

  it('defaults LiteLLM base URL to the in-cluster Service DNS', () => {
    const cfg = parseEnv(baseEnv);
    expect(cfg.litellmBaseUrl).toBe('http://litellm.kagent-system.svc.cluster.local:4000/v1');
  });

  it('honors KAGENT_LITELLM_BASE_URL override', () => {
    const cfg = parseEnv({
      ...baseEnv,
      KAGENT_LITELLM_BASE_URL: 'http://192.168.68.73:11434/v1',
    });
    expect(cfg.litellmBaseUrl).toBe('http://192.168.68.73:11434/v1');
  });

  it('threads KAGENT_LITELLM_API_KEY through when set', () => {
    const cfg = parseEnv({ ...baseEnv, KAGENT_LITELLM_API_KEY: 'sk-test' });
    expect(cfg.litellmApiKey).toBe('sk-test');
  });

  it('omits litellmApiKey when env var is unset', () => {
    const cfg = parseEnv(baseEnv);
    expect(cfg.litellmApiKey).toBeUndefined();
  });

  it('defaults log level to info; honors debug', () => {
    expect(parseEnv(baseEnv).logLevel).toBe('info');
    expect(parseEnv({ ...baseEnv, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it.each([
    'KAGENT_TASK_ID',
    'KAGENT_TASK_NAME',
    'KAGENT_TASK_NAMESPACE',
    'KAGENT_AGENT_NAME',
    'KAGENT_AGENT_SPEC',
    'KAGENT_TASK_SPEC',
  ])('throws on missing required env var %s', (key) => {
    const env = { ...baseEnv };
    delete env[key];
    expect(() => parseEnv(env)).toThrow(new RegExp(`${key}.*missing or empty`));
  });

  it('throws on empty-string required env var', () => {
    expect(() => parseEnv({ ...baseEnv, KAGENT_TASK_ID: '' })).toThrow(
      /KAGENT_TASK_ID.*missing or empty/,
    );
  });

  it('throws when AGENT_SPEC is not valid JSON', () => {
    expect(() => parseEnv({ ...baseEnv, KAGENT_AGENT_SPEC: '{not-json' })).toThrow(
      /failed to parse KAGENT_AGENT_SPEC/,
    );
  });

  it('throws when AGENT_SPEC.model is missing or empty', () => {
    expect(() => parseEnv({ ...baseEnv, KAGENT_AGENT_SPEC: JSON.stringify({}) })).toThrow(
      /AGENT_SPEC.model is required/,
    );
  });

  describe('KAGENT_TRACE_CONTENT_MODE', () => {
    it('defaults to preview when unset', () => {
      expect(parseEnv(baseEnv).traceContentMode).toBe('preview');
    });

    it.each(['none', 'preview', 'full'] as const)('accepts %s', (mode) => {
      expect(parseEnv({ ...baseEnv, KAGENT_TRACE_CONTENT_MODE: mode }).traceContentMode).toBe(mode);
    });

    it('rejects artifact-ref explicitly (depends on Phase 5 P3 writer)', () => {
      expect(() => parseEnv({ ...baseEnv, KAGENT_TRACE_CONTENT_MODE: 'artifact-ref' })).toThrow(
        /artifact-ref.*reserved/,
      );
    });

    it('rejects unknown values', () => {
      expect(() => parseEnv({ ...baseEnv, KAGENT_TRACE_CONTENT_MODE: 'huh' })).toThrow(
        /not a valid value/,
      );
    });
  });
});
