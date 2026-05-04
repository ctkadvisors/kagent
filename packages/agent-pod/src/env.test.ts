/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

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

  it('throws when agent spec.model is missing or empty', () => {
    expect(() => parseEnv({ ...baseEnv, KAGENT_AGENT_SPEC: JSON.stringify({}) })).toThrow(
      /spec\.model is required/,
    );
  });

  describe('AgentSpec.maxInFlightTasks (LLM-gateway opt-in fairness cap)', () => {
    it('round-trips a numeric maxInFlightTasks through KAGENT_AGENT_SPEC', () => {
      const cfg = parseEnv({
        ...baseEnv,
        KAGENT_AGENT_SPEC: JSON.stringify({
          model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
          maxInFlightTasks: 5,
        }),
      });
      expect(cfg.agentSpec.maxInFlightTasks).toBe(5);
    });

    it('leaves maxInFlightTasks undefined when unset (= unlimited at admission layer)', () => {
      const cfg = parseEnv(baseEnv);
      expect(cfg.agentSpec.maxInFlightTasks).toBeUndefined();
    });
  });

  /* =====================================================================
   * v0.1.9 — KAGENT_TASK_DEPTH parsing. Operator stamps it on every
   * spawned Job env (default '0' for root tasks). The agent-pod surfaces
   * it on PodConfig so the spawn tool's depth-cap guardrail and the
   * `get_my_context` introspection tool can read one source of truth.
   * Defensive: malformed / negative / non-integer values fall back to 0
   * — same fail-closed posture as the operator-side parser.
   * ===================================================================== */
  describe('KAGENT_TASK_DEPTH', () => {
    it('defaults taskDepth to 0 when env var is unset', () => {
      const cfg = parseEnv(baseEnv);
      expect(cfg.taskDepth).toBe(0);
    });

    it('parses a non-negative integer string verbatim', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: '3' });
      expect(cfg.taskDepth).toBe(3);
    });

    it('treats empty / negative / non-integer values as 0 (defensive)', () => {
      expect(parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: '' }).taskDepth).toBe(0);
      expect(parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: '-1' }).taskDepth).toBe(0);
      expect(parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: '1.5' }).taskDepth).toBe(0);
      expect(parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: 'NaN' }).taskDepth).toBe(0);
      expect(parseEnv({ ...baseEnv, KAGENT_TASK_DEPTH: 'four' }).taskDepth).toBe(0);
    });
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

  /* =====================================================================
   * v0.2.0-typed-io — agent.spec + task.spec mounted via ConfigMap.
   *
   * The operator's job-spec-builder mounts a per-Job ConfigMap at
   * `/var/kagent/config/{agent,task}.spec.json`. parseEnv reads those
   * files when present and falls back to the v0.1 env-JSON path for
   * one release of back-compat.
   * ===================================================================== */
  describe('v0.2.0 ConfigMap-mounted spec files', () => {
    function makeReader(files: Record<string, string>): (path: string) => string | undefined {
      return (path) => files[path];
    }

    it('reads agent.spec + task.spec from /var/kagent/config when files exist', () => {
      const reader = makeReader({
        '/var/kagent/config/agent.spec.json': JSON.stringify({ model: 'workers-ai/cm-path' }),
        '/var/kagent/config/task.spec.json': JSON.stringify({
          targetAgent: 'r',
          payload: { topic: 'cm-path' },
        }),
      });
      // Strip the env-JSON entries so we KNOW the file path was used.
      const envWithoutJson = { ...baseEnv };
      delete envWithoutJson.KAGENT_AGENT_SPEC;
      delete envWithoutJson.KAGENT_TASK_SPEC;
      const cfg = parseEnv(envWithoutJson, reader);
      expect(cfg.agentSpec.model).toBe('workers-ai/cm-path');
      expect(cfg.taskSpec.payload).toEqual({ topic: 'cm-path' });
    });

    it('ConfigMap path WINS over the env JSON during the back-compat overlap', () => {
      const reader = makeReader({
        '/var/kagent/config/agent.spec.json': JSON.stringify({ model: 'cm/wins' }),
        '/var/kagent/config/task.spec.json': JSON.stringify({
          targetAgent: 'r',
          payload: {},
        }),
      });
      // Both env + files present; file should win.
      const cfg = parseEnv(baseEnv, reader);
      expect(cfg.agentSpec.model).toBe('cm/wins');
    });

    it('falls back to env JSON when ConfigMap files are absent (back-compat)', () => {
      const reader: (path: string) => string | undefined = () => undefined;
      const cfg = parseEnv(baseEnv, reader);
      expect(cfg.agentSpec.model).toBe(
        'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      );
    });

    it('boot-fails with descriptive error when both file path and env are absent', () => {
      const reader: (path: string) => string | undefined = () => undefined;
      const envEmpty = { ...baseEnv };
      delete envEmpty.KAGENT_AGENT_SPEC;
      expect(() => parseEnv(envEmpty, reader)).toThrow(/KAGENT_AGENT_SPEC.*missing or empty/);
    });

    it('logs deprecation warning when AgentTask.spec.parentDistillation is set', () => {
      const reader: (path: string) => string | undefined = () => undefined;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        parseEnv(
          {
            ...baseEnv,
            KAGENT_TASK_SPEC: JSON.stringify({
              targetAgent: 'r',
              payload: {},
              parentDistillation: 'old-style summary',
            }),
          },
          reader,
        );
        expect(warnSpy).toHaveBeenCalled();
        const msg = warnSpy.mock.calls[0]?.[0] as string;
        expect(msg).toContain('parentDistillation is deprecated');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
