/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { assertEnvJsonSpecBudget, ENV_JSON_SPEC_PAYLOAD_MAX_BYTES, parseEnv } from './env.js';

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

  it('threads KAGENT_TOOL_GATEWAY_URL through when set and omits it when blank', () => {
    expect(
      parseEnv({ ...baseEnv, KAGENT_TOOL_GATEWAY_URL: 'http://tool-gateway.kagent-system.svc' })
        .toolGatewayUrl,
    ).toBe('http://tool-gateway.kagent-system.svc');
    expect(parseEnv({ ...baseEnv, KAGENT_TOOL_GATEWAY_URL: '' }).toolGatewayUrl).toBeUndefined();
    expect(parseEnv(baseEnv).toolGatewayUrl).toBeUndefined();
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

  /* =====================================================================
   * v0.1.9 — KAGENT_AGENT_MODEL_CONTEXT_WINDOW parsing. The operator
   * resolves this from `agent.modelClasses[<class>].contextWindowTokens`
   * (per docs/CONTEXT-AWARENESS.md §4.1) and projects it onto every
   * spawned pod. The agent-pod surfaces it on PodConfig.contextWindowTokens
   * so `runner.ts` can thread it onto `RunBudget.contextWindowTokens`.
   *
   * Defensive: absence is normal (back-compat for v0.1.8 / classes that
   * don't declare a window). Malformed values log a warn and degrade to
   * undefined — fail-soft so a typo doesn't take down a long-running
   * AgentTask. Only positive integers parse.
   * ===================================================================== */
  describe('KAGENT_AGENT_MODEL_CONTEXT_WINDOW', () => {
    it('leaves contextWindowTokens undefined when env var is unset (back-compat)', () => {
      const cfg = parseEnv(baseEnv);
      expect(cfg.contextWindowTokens).toBeUndefined();
    });

    it('parses a positive integer verbatim', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '131072' });
      expect(cfg.contextWindowTokens).toBe(131_072);
    });

    it('parses small positive integer (e.g. 8192 for nemotron)', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '8192' });
      expect(cfg.contextWindowTokens).toBe(8192);
    });

    it.each(['', '0', '-1', '1.5', 'NaN', 'one-twenty-eight'])(
      'logs a warn and returns undefined for malformed value %s',
      (raw) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: raw });
          expect(cfg.contextWindowTokens).toBeUndefined();
          // Audit-rev2 M11 — parseEnv now also emits a WARN when the
          // env-JSON spec-source path is taken (deprecated). Filter to
          // the context-window WARN we care about for this assertion.
          const ctxWindowWarns = warnSpy.mock.calls.filter((call) =>
            (call[0] as string).includes('KAGENT_AGENT_MODEL_CONTEXT_WINDOW'),
          );
          if (raw.length > 0) {
            // Empty string is treated as "unset" — no context-window
            // warn. Anything else that fails to parse a positive
            // integer warns once.
            expect(ctxWindowWarns.length).toBeGreaterThan(0);
            const msg = ctxWindowWarns[0]?.[0] as string;
            expect(msg).toContain('KAGENT_AGENT_MODEL_CONTEXT_WINDOW');
          } else {
            expect(ctxWindowWarns.length).toBe(0);
          }
        } finally {
          warnSpy.mockRestore();
        }
      },
    );

    /*
     * Audit-rev2 NH4 follow-up — defense-in-depth bounds at the agent-pod
     * side. Mirrors the operator's parseModelClassesEnv guard. When the
     * env is set to a value above CONTEXT_WINDOW_TOKENS_MAX (= 2_097_152)
     * or below CONTEXT_WINDOW_TOKENS_MIN (= 1000), drop with a structured
     * WARN naming the bound that was violated.
     */
    it('drops with above-MAX warn when value exceeds CONTEXT_WINDOW_TOKENS_MAX (silent-disable trapdoor)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const cfg = parseEnv({
          ...baseEnv,
          KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '999999999999',
        });
        expect(cfg.contextWindowTokens).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        const msg = warnSpy.mock.calls[0]?.[0] as string;
        expect(msg).toContain('above CONTEXT_WINDOW_TOKENS_MAX');
        expect(msg).toContain('2097152');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('drops with below-MIN warn when value is below CONTEXT_WINDOW_TOKENS_MIN (over-trip trapdoor)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const cfg = parseEnv({
          ...baseEnv,
          KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '999',
        });
        expect(cfg.contextWindowTokens).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        const msg = warnSpy.mock.calls[0]?.[0] as string;
        expect(msg).toContain('below CONTEXT_WINDOW_TOKENS_MIN');
        expect(msg).toContain('1000');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('admits exact MIN boundary value (1000)', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '1000' });
      expect(cfg.contextWindowTokens).toBe(1000);
    });

    it('admits exact MAX boundary value (2_097_152)', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '2097152' });
      expect(cfg.contextWindowTokens).toBe(2_097_152);
    });

    it('admits typical production windows (200_000 for Claude 3 Opus)', () => {
      const cfg = parseEnv({ ...baseEnv, KAGENT_AGENT_MODEL_CONTEXT_WINDOW: '200000' });
      expect(cfg.contextWindowTokens).toBe(200_000);
    });
  });

  /* =====================================================================
   * v0.4.1-blackboard — Wave 3 Blackboard sub-team.
   *
   * `KAGENT_BLACKBOARD_BUCKET=kagent-kv-<root-uid>` is stamped by the
   * operator's job-spec render path. parseEnv extracts the
   * `<root-uid>` portion onto `PodConfig.rootTaskUid` so
   * K8sTaskCreator's spawn path can stamp the same root UID on every
   * descendant. Defensive: a missing or malformed env value silently
   * maps to undefined — the agent loop runs without blackboard tools
   * rather than refusing to boot.
   * ===================================================================== */
  describe('KAGENT_BLACKBOARD_BUCKET', () => {
    it('parses rootTaskUid from a well-formed bucket name', () => {
      const cfg = parseEnv({
        ...baseEnv,
        KAGENT_BLACKBOARD_BUCKET: 'kagent-kv-abc-123',
      });
      expect(cfg.rootTaskUid).toBe('abc-123');
    });

    it('leaves rootTaskUid undefined when env unset', () => {
      const cfg = parseEnv(baseEnv);
      expect(cfg.rootTaskUid).toBeUndefined();
    });

    it('leaves rootTaskUid undefined when bucket name has wrong prefix', () => {
      const cfg = parseEnv({
        ...baseEnv,
        KAGENT_BLACKBOARD_BUCKET: 'other-prefix-abc',
      });
      expect(cfg.rootTaskUid).toBeUndefined();
    });

    it('leaves rootTaskUid undefined for the bare prefix', () => {
      const cfg = parseEnv({
        ...baseEnv,
        KAGENT_BLACKBOARD_BUCKET: 'kagent-kv-',
      });
      expect(cfg.rootTaskUid).toBeUndefined();
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
      expect(cfg.agentSpec.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
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

/* =====================================================================
 * Audit C2 H12 — env-JSON spec payload cap + KAGENT_SPEC_SOURCE
 * annotation.
 *
 * The env-JSON path (`KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC`) is the
 * v0.1 back-compat fallback. ARG_MAX bounds it to ~128 KiB on most
 * Linux distros, but enforcement is uneven — a pathological env can
 * fail with a generic exec error before parseEnv runs. Fix: pre-parse
 * 256 KiB combined cap throws structured `env_json_spec_too_large` so
 * CrashLoop has a clear operator-visible reason.
 * ===================================================================== */

describe('assertEnvJsonSpecBudget (H12)', () => {
  it('passes when both env-JSONs are absent (ConfigMap path)', () => {
    expect(() => assertEnvJsonSpecBudget({})).not.toThrow();
  });

  it('passes for typical real-world spec sizes (a few hundred bytes)', () => {
    expect(() =>
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: JSON.stringify({ model: 'gpt-4o', systemPrompt: 'tiny' }),
        KAGENT_TASK_SPEC: JSON.stringify({ payload: { topic: 'ok' } }),
      }),
    ).not.toThrow();
  });

  it('passes at exactly the cap', () => {
    // Pad both vars to total exactly the cap.
    const halfCap = ENV_JSON_SPEC_PAYLOAD_MAX_BYTES / 2;
    const padding = 'x'.repeat(halfCap - 2); // -2 for the surrounding quotes
    expect(() =>
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: `"${padding}"`,
        KAGENT_TASK_SPEC: `"${padding}"`,
      }),
    ).not.toThrow();
  });

  it('throws structured env_json_spec_too_large when combined size exceeds cap', () => {
    // Each var slightly over half-cap so the total is just over.
    const overHalf = Math.ceil(ENV_JSON_SPEC_PAYLOAD_MAX_BYTES / 2) + 100;
    const padding = 'x'.repeat(overHalf - 2);
    expect(() =>
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: `"${padding}"`,
        KAGENT_TASK_SPEC: `"${padding}"`,
      }),
    ).toThrow(/env_json_spec_too_large/);
  });

  it('error message names both env vars and their byte counts', () => {
    const padding = 'x'.repeat(200_000);
    let caught: Error | undefined;
    try {
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: `"${padding}"`,
        KAGENT_TASK_SPEC: `"${padding}"`,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('KAGENT_AGENT_SPEC');
    expect(caught?.message).toContain('KAGENT_TASK_SPEC');
    expect(caught?.message).toContain(String(ENV_JSON_SPEC_PAYLOAD_MAX_BYTES));
    expect(caught?.message).toContain('Migrate to ConfigMap');
  });

  it('counts UTF-8 bytes (not code points) — multibyte chars contribute correctly', () => {
    // A 4-byte UTF-8 char (emoji) at half-cap-of-bytes.
    const halfBytes = Math.floor(ENV_JSON_SPEC_PAYLOAD_MAX_BYTES / 2);
    // 4-byte emoji repeated; total bytes ≈ halfBytes per var.
    const emoji = '\u{1F600}'; // 😀
    const repeats = Math.floor(halfBytes / 4);
    const big = emoji.repeat(repeats);
    // String length is `repeats` (UTF-16 code units count would be 2x
    // due to surrogate pairs, but Buffer.byteLength counts bytes).
    expect(() =>
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: big,
        KAGENT_TASK_SPEC: big,
      }),
    ).not.toThrow(); // exactly at cap
    // Push slightly over with one more emoji.
    expect(() =>
      assertEnvJsonSpecBudget({
        KAGENT_AGENT_SPEC: big + emoji.repeat(2),
        KAGENT_TASK_SPEC: big,
      }),
    ).toThrow(/env_json_spec_too_large/);
  });
});

describe('parseEnv H12 — env-JSON cap + specSource annotation', () => {
  it('stamps specSource=env-json on PodConfig when env-JSON path is taken', () => {
    const cfg = parseEnv(baseEnv);
    expect(cfg.specSource).toBe('env-json');
  });

  it('stamps specSource=configmap when both files are present', () => {
    const reader = vi.fn<(p: string) => string | undefined>((p) => {
      if (p === '/var/kagent/config/agent.spec.json') {
        return JSON.stringify({ model: 'gpt-4o' });
      }
      if (p === '/var/kagent/config/task.spec.json') {
        return JSON.stringify({ payload: {} });
      }
      return undefined;
    });
    const cfg = parseEnv(baseEnv, reader);
    expect(cfg.specSource).toBe('configmap');
  });

  it('stamps specSource=mixed when one file is present and the other falls back to env', () => {
    // Defensive case — partial-mount edge.
    const reader = vi.fn<(p: string) => string | undefined>((p) => {
      if (p === '/var/kagent/config/agent.spec.json') {
        return JSON.stringify({ model: 'gpt-4o' });
      }
      // task.spec.json missing → falls back to KAGENT_TASK_SPEC env.
      return undefined;
    });
    const cfg = parseEnv(baseEnv, reader);
    expect(cfg.specSource).toBe('mixed');
  });

  it('refuses with structured error when env-JSON exceeds 256 KiB combined cap', () => {
    const padding = 'x'.repeat(200_000);
    expect(() =>
      parseEnv({
        ...baseEnv,
        KAGENT_AGENT_SPEC: `{"model":"gpt-4o","systemPrompt":"${padding}"}`,
        KAGENT_TASK_SPEC: `{"payload":{"topic":"${padding}"}}`,
      }),
    ).toThrow(/env_json_spec_too_large/);
  });

  it('cap does NOT trip when ConfigMap path is taken (no env-JSON)', () => {
    // Even a hypothetical 1 MB ConfigMap file should not be rejected
    // by the env-JSON cap — operator-side cap (job-spec.ts) is a
    // separate concern (W3-Operator scope).
    const reader = vi.fn<(p: string) => string | undefined>((p) => {
      if (p === '/var/kagent/config/agent.spec.json') {
        return JSON.stringify({ model: 'gpt-4o', systemPrompt: 'x'.repeat(500_000) });
      }
      if (p === '/var/kagent/config/task.spec.json') {
        return JSON.stringify({ payload: {} });
      }
      return undefined;
    });
    // Even with NO env-JSON, the cap check sees sum=0 and passes.
    const envWithoutJson = { ...baseEnv };
    delete envWithoutJson.KAGENT_AGENT_SPEC;
    delete envWithoutJson.KAGENT_TASK_SPEC;
    expect(() => parseEnv(envWithoutJson, reader)).not.toThrow();
  });

  it('boot log mentions specSource (operator on-call grep target)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      parseEnv(baseEnv);
      const messages = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('spec source: env-json');
    } finally {
      logSpy.mockRestore();
    }
  });
});
