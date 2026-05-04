/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  inputIsRequired,
  inputsMissingMountPath,
  outputIsRequired,
  requiredInputNames,
  requiredOutputNames,
} from './agent.js';
import type { Agent, AgentSpec } from './types.js';
import { API_GROUP_VERSION } from './types.js';

const baseSpec: AgentSpec = {
  model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
};

describe('inputIsRequired', () => {
  it('defaults required-by-default when neither flag set', () => {
    expect(inputIsRequired({ name: 'x', kind: 'scalar' })).toBe(true);
  });

  it('honors explicit required: true', () => {
    expect(inputIsRequired({ name: 'x', kind: 'scalar', required: true })).toBe(true);
  });

  it('honors explicit required: false', () => {
    expect(inputIsRequired({ name: 'x', kind: 'scalar', required: false })).toBe(false);
  });

  it('optional: true wins over required: true (explicit opt-out)', () => {
    expect(
      inputIsRequired({ name: 'x', kind: 'scalar', required: true, optional: true }),
    ).toBe(false);
  });
});

describe('outputIsRequired', () => {
  it('defaults required-by-default', () => {
    expect(outputIsRequired({ name: 'y', kind: 'artifact' })).toBe(true);
  });

  it('honors required: false', () => {
    expect(outputIsRequired({ name: 'y', kind: 'artifact', required: false })).toBe(false);
  });
});

describe('requiredInputNames + requiredOutputNames', () => {
  it('returns empty when no inputs/outputs declared (back-compat with v0.1 Agents)', () => {
    expect(requiredInputNames(baseSpec)).toEqual([]);
    expect(requiredOutputNames(baseSpec)).toEqual([]);
  });

  it('preserves authoring order across required entries', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [
        { name: 'corpus', kind: 'workspace', mountPath: '/var/in/corpus' },
        { name: 'brief', kind: 'artifact', mountPath: '/var/in/brief', optional: true },
        { name: 'mode', kind: 'scalar' },
      ],
      outputs: [
        { name: 'digest', kind: 'artifact', required: true },
        { name: 'extra', kind: 'artifact', required: false },
      ],
    };
    expect(requiredInputNames(spec)).toEqual(['corpus', 'mode']);
    expect(requiredOutputNames(spec)).toEqual(['digest']);
  });

  it('accepts an Agent CR (top-level) or an AgentSpec directly', () => {
    const agent: Agent = {
      apiVersion: API_GROUP_VERSION,
      kind: 'Agent',
      metadata: { name: 'a' },
      spec: { ...baseSpec, inputs: [{ name: 'x', kind: 'scalar' }] },
    };
    expect(requiredInputNames(agent)).toEqual(['x']);
  });
});

describe('inputsMissingMountPath', () => {
  it('returns empty when all workspace/artifact inputs declare a path', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [
        { name: 'a', kind: 'workspace', mountPath: '/var/in/a' },
        { name: 'b', kind: 'artifact', mountPath: '/var/in/b' },
        { name: 'c', kind: 'scalar' },
      ],
    };
    expect(inputsMissingMountPath(spec)).toEqual([]);
  });

  it('flags workspace inputs missing mountPath', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [{ name: 'a', kind: 'workspace' }],
    };
    expect(inputsMissingMountPath(spec)).toEqual(['a']);
  });

  it('flags artifact inputs missing mountPath', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [{ name: 'a', kind: 'artifact' }],
    };
    expect(inputsMissingMountPath(spec)).toEqual(['a']);
  });

  it('flags empty-string mountPath as missing (defensive)', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [{ name: 'a', kind: 'workspace', mountPath: '' }],
    };
    expect(inputsMissingMountPath(spec)).toEqual(['a']);
  });

  it('never flags scalar inputs (mountPath irrelevant)', () => {
    const spec: AgentSpec = {
      ...baseSpec,
      inputs: [{ name: 'a', kind: 'scalar' }],
    };
    expect(inputsMissingMountPath(spec)).toEqual([]);
  });
});
