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
    const app = architectRoute(deps({ architect: { complete: vi.fn(() => Promise.resolve(fenced)) } }));
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

  it('creates an AgentTemplate in kagent-draft and returns its ref', async () => {
    const createNamespacedCustomObject = vi.fn(() =>
      Promise.resolve({ metadata: { name: 'draft-abc123', namespace: 'kagent-draft', uid: 'u1' } }),
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
      body: JSON.stringify({ candidateYaml: VALID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { namespace: string; name: string; uid?: string };
    expect(body.namespace).toBe('kagent-draft');
    expect(body.uid).toBe('u1');
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const arg = createNamespacedCustomObject.mock.calls[0]![0] as {
      group: string;
      plural: string;
      namespace: string;
      body: { kind: string; metadata: { namespace: string } };
    };
    expect(arg.plural).toBe('agenttemplates');
    expect(arg.namespace).toBe('kagent-draft');
    expect(arg.body.kind).toBe('AgentTemplate');
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
