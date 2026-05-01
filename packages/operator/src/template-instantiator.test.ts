/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION } from './crds/types.js';
import type { AgentTemplate, AgentTemplateSpec } from './crds/types.js';
import {
  buildAgentManifest,
  computeBudgetHash,
  computeParameterHash,
  InstantiateError,
  renderAgentSpec,
  sanitizeNameFragment,
} from './template-instantiator.js';

const FIXED_DATE = new Date('2026-05-01T15:00:00Z');

function makeTemplate(over?: Partial<AgentTemplateSpec>): AgentTemplate {
  const baseSpec: AgentTemplateSpec = {
    templateVersion: 3,
    parameters: [
      {
        name: 'topic',
        type: 'string',
        pattern: '^[a-zA-Z0-9 _-]{1,80}$',
        required: true,
      },
      {
        name: 'wordBudget',
        type: 'integer',
        allowedValues: ['100', '200', '400'],
        default: '200',
      },
    ],
    budget: { maxIterations: 6, maxCostUsdPerRun: 0.05 },
    toolAllowlist: ['fetch_url', 'web_search'],
    toolDefaults: ['fetch_url'],
    agentSpec: {
      model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct',
      sandboxProfile: 'default',
      systemPrompt: 'Summarize "${param.topic}" in approximately ${param.wordBudget} words.',
    },
    ...over,
  };
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTemplate',
    metadata: { name: 'summarizer', namespace: 'kagent-system' },
    spec: baseSpec,
  };
}

describe('buildAgentManifest', () => {
  it('renders a clean Agent manifest with templated systemPrompt', () => {
    const template = makeTemplate();
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust async runtimes' },
      createdByTaskUid: 'uid-task-123',
      clock: () => FIXED_DATE,
    });

    expect(result.manifest.kind).toBe('Agent');
    expect(result.manifest.metadata.namespace).toBe('kagent-system');
    expect(result.agentName.startsWith('summarizer-')).toBe(true);
    expect(result.templateRef).toBe('summarizer@v3');
    expect(result.parameterHash.length).toBe(8);
    expect(result.droppedTools).toEqual([]);

    const spec = result.manifest.spec as {
      model: string;
      systemPrompt: string;
      tools: string[];
    };
    expect(spec.model).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct');
    expect(spec.systemPrompt).toBe('Summarize "rust async runtimes" in approximately 200 words.');
    expect(spec.tools).toEqual(['fetch_url']);

    expect(result.manifest.metadata.annotations['kagent.knuteson.io/template-ref']).toBe(
      'summarizer@v3',
    );
    expect(result.manifest.metadata.annotations['kagent.knuteson.io/created-by-task']).toBe(
      'uid-task-123',
    );
    expect(result.manifest.metadata.annotations['kagent.knuteson.io/parameter-hash']).toBe(
      result.parameterHash,
    );
    expect(result.manifest.metadata.annotations['kagent.knuteson.io/budget-hash']).toBe(
      computeBudgetHash(template.spec.budget),
    );
  });

  it('produces deterministic agentName + hash for identical inputs', () => {
    const template = makeTemplate();
    const a = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust async', wordBudget: '200' },
      createdByTaskUid: 'uid-1',
      clock: () => FIXED_DATE,
    });
    const b = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { wordBudget: '200', topic: 'rust async' }, // different key order
      createdByTaskUid: 'uid-2',
      clock: () => FIXED_DATE,
    });
    expect(a.agentName).toBe(b.agentName);
    expect(a.parameterHash).toBe(b.parameterHash);
  });

  it('changes agentName when parameter values differ', () => {
    const template = makeTemplate();
    const a = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust' },
      createdByTaskUid: 'uid',
    });
    const b = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'go' },
      createdByTaskUid: 'uid',
    });
    expect(a.agentName).not.toBe(b.agentName);
  });

  it('uses defaults so the merged hash includes them', () => {
    const template = makeTemplate();
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust' }, // wordBudget defaulted to 200
      createdByTaskUid: 'uid',
    });
    // Hash with explicit wordBudget=200 should match default-merged hash.
    const explicit = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust', wordBudget: '200' },
      createdByTaskUid: 'uid',
    });
    expect(result.parameterHash).toBe(explicit.parameterHash);
  });

  it('rejects unknown parameter names with parameter_unknown', () => {
    const template = makeTemplate();
    expect(() =>
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: 'rust', extra: 'noooo' },
        createdByTaskUid: 'uid',
      }),
    ).toThrow(InstantiateError);
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: 'rust', extra: 'noooo' },
        createdByTaskUid: 'uid',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(InstantiateError);
      expect((err as InstantiateError).code).toBe('parameter_unknown');
    }
  });

  it('rejects missing required parameters with parameter_missing', () => {
    const template = makeTemplate();
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: {}, // topic missing, no default
        createdByTaskUid: 'uid',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InstantiateError);
      expect((err as InstantiateError).code).toBe('parameter_missing');
    }
  });

  it('rejects parameter values that fail the regex pattern', () => {
    const template = makeTemplate();
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: 'invalid topic!@#' }, // pattern allows only [a-zA-Z0-9 _-]
        createdByTaskUid: 'uid',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InstantiateError);
      expect((err as InstantiateError).code).toBe('parameter_invalid');
    }
  });

  it('rejects integer values not in allowedValues', () => {
    const template = makeTemplate();
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: 'rust', wordBudget: '999' },
        createdByTaskUid: 'uid',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstantiateError).code).toBe('parameter_invalid');
    }
  });

  it('rejects non-integer literal for integer params', () => {
    const template = makeTemplate();
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: 'rust', wordBudget: 'two-hundred' },
        createdByTaskUid: 'uid',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstantiateError).code).toBe('parameter_invalid');
    }
  });

  it('rejects oversize parameter values (>256 chars)', () => {
    const template = makeTemplate();
    const long = 'a'.repeat(300);
    try {
      buildAgentManifest(template, {
        templateName: 'summarizer',
        parameterValues: { topic: long },
        createdByTaskUid: 'uid',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstantiateError).code).toBe('parameter_invalid');
    }
  });

  it('intersects toolSelection params with toolAllowlist + reports dropped tools', () => {
    const template = makeTemplate({
      parameters: [{ name: 'tools', type: 'toolSelection', required: true }],
      toolAllowlist: ['fetch_url', 'web_search'],
      toolDefaults: ['fetch_url'],
      agentSpec: { model: 'm', systemPrompt: 'p' },
    });
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { tools: 'fetch_url,evil_shell,web_search' },
      createdByTaskUid: 'uid',
    });
    const spec = result.manifest.spec as { tools: string[] };
    expect(spec.tools).toEqual(['fetch_url', 'web_search']);
    expect(result.droppedTools).toEqual(['evil_shell']);
  });

  it('falls back to toolDefaults when no toolSelection parameter is supplied', () => {
    const template = makeTemplate(); // no toolSelection in parameters
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust' },
      createdByTaskUid: 'uid',
    });
    const spec = result.manifest.spec as { tools: string[] };
    expect(spec.tools).toEqual(['fetch_url']);
  });

  it('writes ownerRef pointing at the createdByTaskUid', () => {
    const template = makeTemplate();
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust' },
      createdByTaskUid: 'uid-task-abc',
    });
    expect(result.manifest.metadata.ownerReferences).toEqual([
      {
        apiVersion: API_GROUP_VERSION,
        kind: 'AgentTask',
        name: 'uid-task-abc',
        uid: 'uid-task-abc',
        controller: false,
        blockOwnerDeletion: false,
      },
    ]);
  });

  it('renders nested objects + arrays in the agentSpec template', () => {
    const template = makeTemplate({
      agentSpec: {
        model: 'm',
        systemPrompt: 'hello ${param.topic}',
        tools: [], // overridden by toolDefaults / toolSelection
        nested: {
          arr: ['static', '${param.topic}', 42],
          flag: true,
        },
      },
    });
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust async' },
      createdByTaskUid: 'uid',
    });
    const spec = result.manifest.spec as {
      systemPrompt: string;
      nested: { arr: unknown[]; flag: boolean };
    };
    expect(spec.systemPrompt).toBe('hello rust async');
    expect(spec.nested.arr).toEqual(['static', 'rust async', 42]);
    expect(spec.nested.flag).toBe(true);
  });

  it('leaves unknown ${param.X} references in place (so typos surface)', () => {
    const template = makeTemplate({
      agentSpec: {
        model: 'm',
        systemPrompt: 'hello ${param.tpoic}', // typo
      },
    });
    const result = buildAgentManifest(template, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust' },
      createdByTaskUid: 'uid',
    });
    const spec = result.manifest.spec as { systemPrompt: string };
    expect(spec.systemPrompt).toBe('hello ${param.tpoic}');
  });
});

describe('renderAgentSpec', () => {
  it('does NOT execute control flow or eval', () => {
    const out = renderAgentSpec(
      { systemPrompt: '${param.x}; alert(1); ${param.y}' },
      { x: 'A', y: 'B' },
    );
    expect((out as { systemPrompt: string }).systemPrompt).toBe('A; alert(1); B');
  });

  it('passes non-string leaves through', () => {
    expect(renderAgentSpec(42, { a: '1' })).toBe(42);
    expect(renderAgentSpec(true, { a: '1' })).toBe(true);
    expect(renderAgentSpec(null, { a: '1' })).toBe(null);
  });
});

describe('sanitizeNameFragment', () => {
  it('lowercases and strips invalid characters', () => {
    expect(sanitizeNameFragment('Hello World!')).toBe('hello-world');
  });

  it('trims leading/trailing dashes', () => {
    expect(sanitizeNameFragment('--abc--')).toBe('abc');
  });

  it('caps at 40 chars', () => {
    expect(sanitizeNameFragment('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe('computeParameterHash', () => {
  it('is order-independent', () => {
    expect(computeParameterHash({ a: '1', b: '2' })).toBe(computeParameterHash({ b: '2', a: '1' }));
  });

  it('changes when values change', () => {
    expect(computeParameterHash({ a: '1' })).not.toBe(computeParameterHash({ a: '2' }));
  });

  it('returns 8-char base32 string', () => {
    const h = computeParameterHash({ topic: 'rust' });
    expect(h).toMatch(/^[a-z2-7]{8}$/);
  });
});
