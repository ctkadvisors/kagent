/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-02 — template-candidate parser tests.
 *
 * Validates `parseAgentTemplateSpec`: YAML → object → shape-validate.
 * The parser is the gate the accept handler runs before creating an
 * AgentTemplate CR — every failure path here prevents a malformed
 * CR from reaching the K8s API server.
 */

import { describe, expect, it } from 'vitest';

import { parseAgentTemplateSpec, type AgentTemplateSpec } from './template-candidate.js';

// Minimal valid YAML conforming to AgentTemplateSpec
const VALID_YAML = `
agentSpec:
  model: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct"
  systemPrompt: "You are a research specialist."
templateVersion: 1
parameters:
  - name: topic
    type: string
    required: true
budget:
  maxIterations: 10
toolAllowlist:
  - http
`;

const FULL_YAML = `
agentSpec:
  model: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct"
  systemPrompt: "You are a \${param.role} specialist."
templateVersion: 2
revisionHistoryLimit: 5
idleTtlSeconds: 3600
parameters:
  - name: role
    type: string
    required: true
    default: "research"
  - name: maxTools
    type: integer
    allowedValues: ["3", "5", "10"]
budget:
  maxIterations: 20
  maxCostUsdPerRun: 0.10
  maxParallelInstances: 2
toolAllowlist:
  - http
  - write_artifact
toolDefaults:
  - http
`;

describe('parseAgentTemplateSpec — valid YAML', () => {
  it('round-trips a minimal valid AgentTemplateSpec YAML → ok:true', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.agentSpec).toBeDefined();
    expect(typeof result.spec.agentSpec).toBe('object');
  });

  it('parses templateVersion as a number', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.templateVersion).toBe(1);
  });

  it('parses parameters array', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(Array.isArray(result.spec.parameters)).toBe(true);
    expect(result.spec.parameters).toHaveLength(1);
    expect(result.spec.parameters![0]!.name).toBe('topic');
    expect(result.spec.parameters![0]!.type).toBe('string');
  });

  it('parses budget.maxIterations', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.budget?.maxIterations).toBe(10);
  });

  it('parses toolAllowlist', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.toolAllowlist).toEqual(['http']);
  });

  it('round-trips a full AgentTemplateSpec with all optional fields → ok:true', () => {
    const result = parseAgentTemplateSpec(FULL_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    const spec = result.spec;
    expect(spec.templateVersion).toBe(2);
    expect(spec.revisionHistoryLimit).toBe(5);
    expect(spec.idleTtlSeconds).toBe(3600);
    expect(spec.parameters).toHaveLength(2);
    expect(spec.budget?.maxIterations).toBe(20);
    expect(spec.budget?.maxCostUsdPerRun).toBeCloseTo(0.1);
    expect(spec.budget?.maxParallelInstances).toBe(2);
    expect(spec.toolAllowlist).toEqual(['http', 'write_artifact']);
    expect(spec.toolDefaults).toEqual(['http']);
  });

  it('accepts a YAML with ONLY agentSpec (all other fields optional)', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct"
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.agentSpec).toBeDefined();
    expect(result.spec.parameters).toBeUndefined();
    expect(result.spec.budget).toBeUndefined();
  });

  it('accepts agentSpec with modelClass instead of model', () => {
    const yaml = `
agentSpec:
  modelClass: "text-generator-default"
  systemPrompt: "Reply tersely."
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.agentSpec['modelClass']).toBe('text-generator-default');
  });

  it('accepts parameters with toolSelection type', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters:
  - name: tools
    type: toolSelection
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.spec.parameters![0]!.type).toBe('toolSelection');
  });
});

describe('parseAgentTemplateSpec — failure paths', () => {
  it('returns ok:false for malformed YAML (syntax error)', () => {
    const badYaml = `
agentSpec:
  model: "unclosed
`;
    const result = parseAgentTemplateSpec(badYaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/YAML parse error/);
  });

  it('returns ok:false when root is not an object (string)', () => {
    const result = parseAgentTemplateSpec('"just a string"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/root must be a non-null object/);
  });

  it('returns ok:false when root is not an object (array)', () => {
    const result = parseAgentTemplateSpec('- item1\n- item2\n');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/root must be a non-null object/);
  });

  it('returns ok:false when root is null', () => {
    const result = parseAgentTemplateSpec('null');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/root must be a non-null object/);
  });

  it('returns ok:false when agentSpec is missing', () => {
    const yaml = `
templateVersion: 1
parameters:
  - name: topic
    type: string
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/agentSpec is required/);
  });

  it('returns ok:false when agentSpec is a string (not object)', () => {
    const yaml = `
agentSpec: "not-an-object"
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/agentSpec must be a non-null object/);
  });

  it('returns ok:false when agentSpec is null', () => {
    const yaml = `agentSpec: null\n`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/agentSpec must be a non-null object/);
  });

  it('returns ok:false when agentSpec is an array', () => {
    const yaml = `agentSpec:\n  - item\n`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/agentSpec must be a non-null object/);
  });

  it('returns ok:false when agentSpec lacks model and modelClass', () => {
    const yaml = `
agentSpec:
  systemPrompt: "missing a runnable model binding"
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/agentSpec must declare model or modelClass/);
  });

  it('returns ok:false when templateVersion is not a positive integer', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
templateVersion: 0
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/templateVersion must be a positive integer/);
  });

  it('returns ok:false when templateVersion is a float', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
templateVersion: 1.5
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/templateVersion must be a positive integer/);
  });

  it('returns ok:false when parameters is not an array', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters: "not-an-array"
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/parameters must be an array/);
  });

  it('returns ok:false when a parameter has an unknown type', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters:
  - name: myParam
    type: boolean
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/type 'boolean' is not one of/);
  });

  it('returns ok:false when a parameter is missing name', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters:
  - type: string
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/parameters\[0\].name must be a non-empty string/);
  });

  it('returns ok:false when a parameter is missing type', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters:
  - name: myParam
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/parameters\[0\].type/);
  });

  it('returns ok:false when a parameter name does not match the CRD pattern', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
parameters:
  - name: release-notes
    type: string
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/parameters\[0\]\.name.*pattern/);
  });

  it('returns ok:false when budget is not an object', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
budget: "not-an-object"
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/budget must be a non-null object/);
  });

  it('returns ok:false when revisionHistoryLimit is outside the CRD range', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
revisionHistoryLimit: 1001
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/revisionHistoryLimit.*integer in \[1, 1000\]/);
  });

  it('returns ok:false when idleTtlSeconds is outside the CRD range', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
idleTtlSeconds: 59
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/idleTtlSeconds.*integer in \[60, 86400\]/);
  });

  it('returns ok:false when budget.maxIterations is a float', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
budget:
  maxIterations: 1.5
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/budget.maxIterations.*integer in \[1, 1000\]/);
  });

  it('returns ok:false when budget.maxParallelInstances is outside the CRD range', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
budget:
  maxParallelInstances: 10001
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/budget.maxParallelInstances.*integer in \[1, 10000\]/);
  });

  it('returns ok:false when toolAllowlist is not an array', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
toolAllowlist: http
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/toolAllowlist must be an array/);
  });

  it('returns ok:false when toolDefaults is not a subset of toolAllowlist', () => {
    const yaml = `
agentSpec:
  model: "workers-ai/llama-4"
toolAllowlist:
  - http
toolDefaults:
  - write_artifact
`;
    const result = parseAgentTemplateSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toMatch(/toolDefaults.*toolAllowlist/);
  });

  it('returns ok:false when empty string is passed', () => {
    const result = parseAgentTemplateSpec('');
    // empty YAML parses to null in the yaml package
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
  });
});

describe('parseAgentTemplateSpec — type-level', () => {
  it('returns spec typed as AgentTemplateSpec on ok:true', () => {
    const result = parseAgentTemplateSpec(VALID_YAML);
    if (!result.ok) throw new Error('expected ok:true');
    // TypeScript type narrowing: accessing .spec here proves the type is correct.
    const spec: AgentTemplateSpec = result.spec;
    expect(typeof spec.agentSpec).toBe('object');
  });
});
