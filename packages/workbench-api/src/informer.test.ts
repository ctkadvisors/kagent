/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Regression coverage for `isAgentShape` — the type-narrowing guard
 * the workbench-api informer applies to every Agent watch event. Pre
 * v0.1.8-modelclass this required `spec.model: string`, which silently
 * filtered every Agent that migrated to `modelClass`-only out of the
 * SnapshotCache and made the /api/agents endpoint serve stale
 * pre-migration snapshots forever. The guard now mirrors the CRD
 * admission rule: at-least-one of `model` or `modelClass` MUST be a
 * non-empty string.
 */

import { describe, expect, it } from 'vitest';

import { isAgentShape } from './informer.js';

describe('isAgentShape', () => {
  it('accepts an Agent with only spec.model set (legacy pinned)', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'rc-pilot-orchestrator' },
      spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
    };
    expect(isAgentShape(obj)).toBe(true);
  });

  it('accepts an Agent with only spec.modelClass set (post-migration)', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'orchestrator' },
      spec: { modelClass: 'tool-caller-default' },
    };
    expect(isAgentShape(obj)).toBe(true);
  });

  it('accepts an Agent with both spec.model and spec.modelClass set (escape-hatch)', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'orchestrator' },
      spec: {
        model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
        modelClass: 'tool-caller-default',
      },
    };
    expect(isAgentShape(obj)).toBe(true);
  });

  it('rejects an Agent with neither model nor modelClass (admission would also reject)', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'broken' },
      spec: { systemPrompt: 'hello' },
    };
    expect(isAgentShape(obj)).toBe(false);
  });

  it('rejects empty-string model and empty-string modelClass', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'broken' },
      spec: { model: '', modelClass: '' },
    };
    expect(isAgentShape(obj)).toBe(false);
  });

  it('rejects non-Agent kinds with the same shape', () => {
    const obj = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: { name: 'foo' },
      spec: { modelClass: 'tool-caller-default' },
    };
    expect(isAgentShape(obj)).toBe(false);
  });

  it('rejects objects without spec', () => {
    expect(isAgentShape({ kind: 'Agent', metadata: { name: 'x' } })).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isAgentShape(null)).toBe(false);
    expect(isAgentShape(undefined)).toBe(false);
    expect(isAgentShape('Agent')).toBe(false);
    expect(isAgentShape(42)).toBe(false);
  });
});
