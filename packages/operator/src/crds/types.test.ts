/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP, API_GROUP_VERSION, API_VERSION, isAgent, isAgentTask } from './types.js';

describe('CRD constants', () => {
  it('uses kagent.knuteson.io group + v1alpha1 (avoids kagent.dev collision)', () => {
    expect(API_GROUP).toBe('kagent.knuteson.io');
    expect(API_VERSION).toBe('v1alpha1');
    expect(API_GROUP_VERSION).toBe('kagent.knuteson.io/v1alpha1');
  });
});

describe('isAgentTask', () => {
  const valid = {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default' },
    spec: { payload: { x: 1 } },
  };

  it('accepts a well-formed AgentTask', () => {
    expect(isAgentTask(valid)).toBe(true);
  });

  it('rejects null and non-objects', () => {
    expect(isAgentTask(null)).toBe(false);
    expect(isAgentTask('AgentTask')).toBe(false);
    expect(isAgentTask(42)).toBe(false);
  });

  it('rejects wrong apiVersion (e.g., kagent.dev/v1)', () => {
    expect(isAgentTask({ ...valid, apiVersion: 'kagent.dev/v1' })).toBe(false);
  });

  it('rejects wrong kind', () => {
    expect(isAgentTask({ ...valid, kind: 'Agent' })).toBe(false);
  });

  it('rejects missing spec', () => {
    expect(isAgentTask({ ...valid, spec: undefined })).toBe(false);
  });
});

describe('isAgent', () => {
  const valid = {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name: 'researcher' },
    spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
  };

  it('accepts a well-formed Agent', () => {
    expect(isAgent(valid)).toBe(true);
  });

  it('rejects empty model', () => {
    expect(isAgent({ ...valid, spec: { model: '' } })).toBe(false);
  });

  it('rejects missing model field', () => {
    expect(isAgent({ ...valid, spec: {} })).toBe(false);
  });

  it('rejects non-string model', () => {
    expect(isAgent({ ...valid, spec: { model: 42 } })).toBe(false);
  });
});
