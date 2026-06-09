/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { buildSandboxEnv, findForbiddenEnvKeys } from './env-policy.js';

describe('tool gateway env policy', () => {
  it('builds a minimal sandbox env without ambient process variables', () => {
    const env = buildSandboxEnv({
      ambientEnv: {
        PATH: '/opt/homebrew/bin',
        HOME: '/Users/chris',
        OPENAI_API_KEY: 'secret',
        DATABASE_URL: 'postgres://secret',
      },
      context: {
        taskUid: 'task-1',
        agentName: 'investigator',
        namespace: 'kagent-draft',
        sessionId: 'code-1',
        toolKind: 'code_interpreter',
      },
    });

    expect(env).toEqual({
      HOME: '/workspace',
      TMPDIR: '/tmp',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      KAGENT_TASK_UID: 'task-1',
      KAGENT_AGENT_NAME: 'investigator',
      KAGENT_NAMESPACE: 'kagent-draft',
      KAGENT_TOOL_SESSION_ID: 'code-1',
      KAGENT_TOOL_KIND: 'code_interpreter',
    });
  });

  it('reports forbidden keys before launching a sandbox', () => {
    expect(
      findForbiddenEnvKeys({
        OPENAI_API_KEY: 'x',
        openai_api_key: 'x',
        PATH: '/bin',
        KUBECONFIG: '/tmp/config',
      }),
    ).toEqual(['OPENAI_API_KEY', 'openai_api_key', 'KUBECONFIG']);
  });
});
