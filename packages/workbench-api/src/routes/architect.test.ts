/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import { architectRoute, type ArchitectRouteDeps } from './architect.js';

// Minimal valid AgentTemplateSpec candidate (agentSpec is the only
// required field per parseAgentTemplateSpec).
const VALID = [
  'agentSpec:',
  '  model: m1',
  '  systemPrompt: summarize the input',
  'budget:',
  '  maxIterations: 6',
  '',
].join('\n');
const MODEL_CLASS_ALIAS_AS_MODEL = [
  'agentSpec:',
  '  model: text-generator-default',
  '  systemPrompt: summarize the input',
  '',
].join('\n');
const PARAMETERIZED_WITH_DEFAULTS = [
  'parameters:',
  '  - name: topic',
  '    type: string',
  '    required: true',
  '    default: Kubernetes operators',
  'toolAllowlist:',
  '  - fetch_url',
  '  - web_search',
  'toolDefaults:',
  '  - fetch_url',
  'agentSpec:',
  '  model: m1',
  '  systemPrompt: "summarize ${param.topic}"',
  '  tools:',
  '    - web_search',
  '',
].join('\n');
const PARAMETERIZED_WITHOUT_REQUIRED_DEFAULT = [
  'parameters:',
  '  - name: topic',
  '    type: string',
  '    required: true',
  'agentSpec:',
  '  model: m1',
  '  systemPrompt: "summarize ${param.topic}"',
  '',
].join('\n');

function deps(over: Partial<ArchitectRouteDeps> = {}): ArchitectRouteDeps {
  return {
    architect: { complete: vi.fn(() => Promise.resolve(VALID)) },
    maxRepairs: 2,
    ...over,
  };
}

describe('POST /api/architect/draft', () => {
  it('returns the candidate + parsed preview when the LLM emits valid YAML', async () => {
    const app = architectRoute(deps());
    const res = await app.request('/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'a summarizer' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; candidateYaml: string; preview: unknown };
    expect(body.ok).toBe(true);
    expect(body.candidateYaml).toContain('systemPrompt');
    expect(body.preview).toBeDefined();
  });

  it('strips code fences the model may wrap around the YAML', async () => {
    const fenced = '```yaml\n' + VALID + '```';
    const app = architectRoute(
      deps({ architect: { complete: vi.fn(() => Promise.resolve(fenced)) } }),
    );
    const res = await app.request('/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x' }),
    });
    expect(res.status).toBe(200);
  });

  it('runs the repair loop when the first output is invalid, then succeeds', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('not valid: yaml: at: all:')
      .mockResolvedValueOnce(VALID);
    const app = architectRoute(deps({ architect: { complete } }));
    const res = await app.request('/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('returns 422 with the last validation error after exhausting repairs', async () => {
    const complete = vi.fn(() => Promise.resolve('just a string, not a mapping'));
    const app = architectRoute(deps({ architect: { complete }, maxRepairs: 1 }));
    const res = await app.request('/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/could not produce a valid/i);
    expect(complete).toHaveBeenCalledTimes(2); // first attempt + 1 repair
  });

  it('400s when goal is missing or empty', async () => {
    const app = architectRoute(deps());
    const res = await app.request('/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/architect/try', () => {
  it('503s when no customApi is configured (write surface disabled)', async () => {
    const app = architectRoute(deps()); // no customApi
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: VALID }),
    });
    expect(res.status).toBe(503);
  });

  it('creates an AgentTemplate, draft Agent, and live AgentTask with trace links', async () => {
    const createNamespacedCustomObject = vi.fn((arg: { plural: string }) => {
      if (arg.plural === 'agenttemplates') {
        return Promise.resolve({
          metadata: { name: 'draft-abc123', namespace: 'kagent-draft', uid: 'template-u1' },
        });
      }
      if (arg.plural === 'agents') {
        return Promise.resolve({
          metadata: { name: 'draft-abc123-agent', namespace: 'kagent-draft', uid: 'agent-u1' },
        });
      }
      return Promise.resolve({
        metadata: { name: 'draft-abc123-run', namespace: 'kagent-draft', uid: 'task-u1' },
      });
    });
    const app = architectRoute(
      deps({
        customApi: { createNamespacedCustomObject } as never,
        draftNamespace: 'kagent-draft',
        langfuseBaseUrl: 'https://lf.example',
        generateName: () => 'abc123',
      }),
    );
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: VALID, goal: 'summarize this payload' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      namespace: string;
      templateName: string;
      agentName: string;
      taskName: string;
      taskUid?: string;
      _links?: { detail?: string; ui?: string; langfuse?: string };
    };
    expect(body.namespace).toBe('kagent-draft');
    expect(body.templateName).toBe('draft-abc123');
    expect(body.agentName).toBe('draft-abc123-agent');
    expect(body.taskName).toBe('draft-abc123-run');
    expect(body.taskUid).toBe('task-u1');
    expect(body._links?.detail).toBe('/api/tasks/kagent-draft/draft-abc123-run');
    expect(body._links?.ui).toBe('/#/tasks/kagent-draft/draft-abc123-run');
    expect(body._links?.langfuse).toMatch(/^https:\/\/lf\.example\/trace\/[0-9a-f]{32}$/);

    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(3);
    const templateArg = createNamespacedCustomObject.mock.calls[0]![0] as {
      group: string;
      plural: string;
      namespace: string;
      body: { kind: string; metadata: { name: string; namespace: string } };
    };
    expect(templateArg.plural).toBe('agenttemplates');
    expect(templateArg.namespace).toBe('kagent-draft');
    expect(templateArg.body.kind).toBe('AgentTemplate');
    expect(templateArg.body.metadata.name).toBe('draft-abc123');

    const agentArg = createNamespacedCustomObject.mock.calls[1]![0] as {
      plural: string;
      namespace: string;
      body: { kind: string; metadata: { name: string }; spec: { model: string } };
    };
    expect(agentArg.plural).toBe('agents');
    expect(agentArg.namespace).toBe('kagent-draft');
    expect(agentArg.body.kind).toBe('Agent');
    expect(agentArg.body.metadata.name).toBe('draft-abc123-agent');
    expect(agentArg.body.spec.model).toBe('m1');

    const taskArg = createNamespacedCustomObject.mock.calls[2]![0] as {
      plural: string;
      namespace: string;
      body: {
        kind: string;
        metadata: { name: string };
        spec: {
          targetAgent: string;
          originalUserMessage: string;
          payload: Record<string, unknown>;
        };
      };
    };
    expect(taskArg.plural).toBe('agenttasks');
    expect(taskArg.namespace).toBe('kagent-draft');
    expect(taskArg.body.kind).toBe('AgentTask');
    expect(taskArg.body.metadata.name).toBe('draft-abc123-run');
    expect(taskArg.body.spec.targetAgent).toBe('draft-abc123-agent');
    expect(taskArg.body.spec.originalUserMessage).toBe('summarize this payload');
    expect(taskArg.body.spec.payload).toMatchObject({
      goal: 'summarize this payload',
      candidateYaml: VALID,
    });
  });

  it('normalizes known model-class aliases emitted in agentSpec.model before creating CRs', async () => {
    const createNamespacedCustomObject = vi.fn(() =>
      Promise.resolve({ metadata: { name: 'created', namespace: 'kagent-draft', uid: 'u1' } }),
    );
    const app = architectRoute(
      deps({
        customApi: { createNamespacedCustomObject } as never,
        draftNamespace: 'kagent-draft',
        generateName: () => 'abc123',
      }),
    );
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: MODEL_CLASS_ALIAS_AS_MODEL }),
    });
    expect(res.status).toBe(201);

    const templateArg = createNamespacedCustomObject.mock.calls[0]![0] as {
      body: { spec: { agentSpec: Record<string, unknown> } };
    };
    const agentArg = createNamespacedCustomObject.mock.calls[1]![0] as {
      body: { spec: Record<string, unknown> };
    };
    expect(templateArg.body.spec.agentSpec).toMatchObject({
      modelClass: 'text-generator-default',
    });
    expect(templateArg.body.spec.agentSpec['model']).toBeUndefined();
    expect(agentArg.body.spec).toMatchObject({ modelClass: 'text-generator-default' });
    expect(agentArg.body.spec['model']).toBeUndefined();
  });

  it('renders default parameter values and toolDefaults before creating the draft Agent', async () => {
    const createNamespacedCustomObject = vi.fn((arg: { plural: string }) =>
      Promise.resolve({
        metadata: {
          name:
            arg.plural === 'agenttemplates'
              ? 'draft-abc123'
              : arg.plural === 'agents'
                ? 'draft-abc123-agent'
                : 'draft-abc123-run',
          namespace: 'kagent-draft',
          uid: `${arg.plural}-uid`,
        },
      }),
    );
    const app = architectRoute(
      deps({
        customApi: { createNamespacedCustomObject } as never,
        draftNamespace: 'kagent-draft',
        generateName: () => 'abc123',
      }),
    );
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: PARAMETERIZED_WITH_DEFAULTS }),
    });
    expect(res.status).toBe(201);

    const agentArg = createNamespacedCustomObject.mock.calls[1]![0] as {
      body: { spec: { systemPrompt?: string; tools?: readonly string[] } };
    };
    expect(agentArg.body.spec.systemPrompt).toBe('summarize Kubernetes operators');
    expect(agentArg.body.spec.tools).toEqual(['fetch_url']);
  });

  it('422s instead of creating partial resources when /try has a required parameter without a default', async () => {
    const createNamespacedCustomObject = vi.fn();
    const app = architectRoute(
      deps({
        customApi: { createNamespacedCustomObject } as never,
        draftNamespace: 'kagent-draft',
        generateName: () => 'abc123',
      }),
    );
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: PARAMETERIZED_WITHOUT_REQUIRED_DEFAULT }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string; detail?: string };
    expect(body.error).toBe('invalid candidate');
    expect(body.detail).toMatch(/parameter "topic" requires a default/i);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('422s when candidateYaml fails validation', async () => {
    const app = architectRoute(
      deps({ customApi: { createNamespacedCustomObject: vi.fn() } as never }),
    );
    const res = await app.request('/try', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateYaml: 'garbage-string' }),
    });
    expect(res.status).toBe(422);
  });
});
