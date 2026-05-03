/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  API_GROUP,
  API_GROUP_VERSION,
  API_VERSION,
  isAgent,
  isAgentTask,
  isModelEndpoint,
} from './types.js';

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

describe('AgentTaskStatus.artifacts (additive field)', () => {
  it('accepts an empty / undefined artifacts array on a status object', () => {
    // Type-only assertion: a status without artifacts must still type-check.
    const status: import('./types.js').AgentTaskStatus = { phase: 'Completed' };
    expect(status.artifacts).toBeUndefined();
  });

  it('round-trips an artifacts array of well-formed refs', () => {
    const status: import('./types.js').AgentTaskStatus = {
      phase: 'Completed',
      artifacts: [
        {
          uri: 'pvc://kagent-artifacts/uid-1/digest.md',
          mediaType: 'text/markdown',
          sizeBytes: 1234,
          name: 'digest.md',
        },
      ],
    };
    expect(status.artifacts?.[0]?.uri).toBe('pvc://kagent-artifacts/uid-1/digest.md');
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

describe('Agent.spec.maxInFlightTasks (LLM-gateway opt-in fairness cap)', () => {
  it('round-trips a numeric maxInFlightTasks on AgentSpec', () => {
    // Type-only assertion: an Agent spec with maxInFlightTasks must type-check.
    const spec: import('./types.js').AgentSpec = {
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      maxInFlightTasks: 3,
    };
    expect(spec.maxInFlightTasks).toBe(3);
  });

  it('accepts an AgentSpec with maxInFlightTasks unset (default = unlimited at this layer)', () => {
    const spec: import('./types.js').AgentSpec = {
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    };
    expect(spec.maxInFlightTasks).toBeUndefined();
  });
});

describe('isModelEndpoint', () => {
  const valid = {
    apiVersion: API_GROUP_VERSION,
    kind: 'ModelEndpoint',
    metadata: { name: 'nemotron-jetson', namespace: 'kagent-system' },
    spec: {
      model: 'nemotron-3-nano:4b',
      backendKind: 'ollama',
      backendUrl: 'http://192.168.68.73:11434',
      inFlight: { seed: 1, max: 4 },
    },
  };

  it('accepts a well-formed ModelEndpoint', () => {
    expect(isModelEndpoint(valid)).toBe(true);
  });

  it('rejects null and non-objects', () => {
    expect(isModelEndpoint(null)).toBe(false);
    expect(isModelEndpoint('ModelEndpoint')).toBe(false);
    expect(isModelEndpoint(42)).toBe(false);
  });

  it('rejects wrong apiVersion (e.g., kagent.dev/v1)', () => {
    expect(isModelEndpoint({ ...valid, apiVersion: 'kagent.dev/v1' })).toBe(false);
  });

  it('rejects wrong kind', () => {
    expect(isModelEndpoint({ ...valid, kind: 'Agent' })).toBe(false);
  });

  it('rejects missing spec', () => {
    expect(isModelEndpoint({ ...valid, spec: undefined })).toBe(false);
  });

  it('rejects empty model', () => {
    expect(isModelEndpoint({ ...valid, spec: { ...valid.spec, model: '' } })).toBe(false);
  });

  it('rejects missing model field', () => {
    expect(
      isModelEndpoint({
        ...valid,
        spec: {
          backendKind: 'ollama',
          backendUrl: 'http://x',
          inFlight: { seed: 1, max: 4 },
        },
      }),
    ).toBe(false);
  });

  it('rejects missing backendKind', () => {
    expect(
      isModelEndpoint({
        ...valid,
        spec: {
          model: 'nemotron-3-nano:4b',
          backendUrl: 'http://x',
          inFlight: { seed: 1, max: 4 },
        },
      }),
    ).toBe(false);
  });

  it('rejects missing backendUrl', () => {
    expect(
      isModelEndpoint({
        ...valid,
        spec: {
          model: 'nemotron-3-nano:4b',
          backendKind: 'ollama',
          inFlight: { seed: 1, max: 4 },
        },
      }),
    ).toBe(false);
  });

  it('rejects missing inFlight', () => {
    expect(
      isModelEndpoint({
        ...valid,
        spec: {
          model: 'nemotron-3-nano:4b',
          backendKind: 'ollama',
          backendUrl: 'http://x',
        },
      }),
    ).toBe(false);
  });

  it('rejects non-numeric inFlight.seed/max', () => {
    expect(
      isModelEndpoint({
        ...valid,
        spec: { ...valid.spec, inFlight: { seed: '1', max: 4 } },
      }),
    ).toBe(false);
  });

  it('round-trips a status block (gateway-written observedInFlight)', () => {
    const me: import('./types.js').ModelEndpoint = {
      ...valid,
      apiVersion: API_GROUP_VERSION,
      kind: 'ModelEndpoint',
      status: {
        observedInFlight: 2,
        lastSampledAt: '2026-05-03T18:30:00Z',
        recentErrorRate: 0.02,
      },
    };
    expect(me.status?.observedInFlight).toBe(2);
    expect(me.status?.recentErrorRate).toBe(0.02);
  });
});
