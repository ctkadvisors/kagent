/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  CODE_INTERPRETER_TOOL_NAMES,
  DEFAULT_TOOL_SESSION_ENV,
  FORBIDDEN_TOOL_SESSION_ENV_KEYS,
  TOOL_KINDS,
  buildToolSessionKey,
  filterToolSessionEnv,
  isCodeInterpreterTool,
  isForbiddenToolSessionEnvKey,
  isToolKind,
} from './tool-session.js';

describe('tool-session DTO contracts', () => {
  it('recognizes only browser and code_interpreter as tool kinds', () => {
    expect(TOOL_KINDS).toEqual(['browser', 'code_interpreter']);
    expect(isToolKind('browser')).toBe(true);
    expect(isToolKind('code_interpreter')).toBe(true);
    expect(isToolKind('shell')).toBe(false);
  });

  it('builds a task-scoped session key that includes tenant, namespace, task uid, tool kind, and session id', () => {
    expect(
      buildToolSessionKey({
        tenant: 'homelab',
        namespace: 'kagent-draft',
        agentTaskUid: 'task-123',
        toolKind: 'browser',
        sessionId: 'sess-1',
      }),
    ).toBe('homelab/kagent-draft/task-123/browser/sess-1');
  });

  it('declares AgentCore-shaped code interpreter tools', () => {
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.execute_code');
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.write_files');
    expect(CODE_INTERPRETER_TOOL_NAMES).toContain('code_interpreter.stop_task');
    expect(isCodeInterpreterTool('code_interpreter.execute_command')).toBe(true);
    expect(isCodeInterpreterTool('browser.goto')).toBe(false);
  });

  it('filters sandbox env to the explicit allowlist and never forwards ambient secrets', () => {
    const env = filterToolSessionEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/chris',
        OPENAI_API_KEY: 'secret',
        CLOUDFLARE_API_TOKEN: 'secret',
        KAGENT_TASK_UID: 'wrong',
        EXTRA: 'nope',
      },
      {
        taskUid: 'task-123',
        agentName: 'agent',
        namespace: 'kagent-draft',
        sessionId: 'sess-1',
        toolKind: 'code_interpreter',
      },
    );

    expect(env).toEqual({
      ...DEFAULT_TOOL_SESSION_ENV,
      KAGENT_TASK_UID: 'task-123',
      KAGENT_AGENT_NAME: 'agent',
      KAGENT_NAMESPACE: 'kagent-draft',
      KAGENT_TOOL_SESSION_ID: 'sess-1',
      KAGENT_TOOL_KIND: 'code_interpreter',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(env).not.toHaveProperty('EXTRA');
  });

  it('catches forbidden env keys case-insensitively', () => {
    expect(FORBIDDEN_TOOL_SESSION_ENV_KEYS).toContain('KUBECONFIG');
    expect(isForbiddenToolSessionEnvKey('openai_api_key')).toBe(true);
    expect(isForbiddenToolSessionEnvKey('KUBERNETES_SERVICE_HOST')).toBe(true);
    expect(isForbiddenToolSessionEnvKey('PATH')).toBe(false);
  });
});
