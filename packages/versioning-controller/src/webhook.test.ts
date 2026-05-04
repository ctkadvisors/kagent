/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { PUBLISHED_ANNOTATION } from './constants.js';
import type { VersionedAgent } from './types.js';
import {
  isStructurallyEqual,
  reviewAgentAdmission,
  validateAgentMutation,
  type AdmissionReviewRequest,
} from './webhook.js';

function agent(overrides: {
  spec?: Record<string, unknown>;
  annotations?: Record<string, string>;
  name?: string;
  namespace?: string;
}): VersionedAgent {
  return {
    metadata: {
      name: overrides.name ?? 'a',
      namespace: overrides.namespace ?? 'default',
      ...(overrides.annotations !== undefined && { annotations: overrides.annotations }),
    },
    spec: overrides.spec ?? { model: 'test/model', version: '1.0.0' },
  };
}

describe('validateAgentMutation', () => {
  it('passes a no-op update', () => {
    const a = agent({});
    const result = validateAgentMutation(a, a);
    expect(result.ok).toBe(true);
  });

  it('refuses any change to spec.* with reason agent_immutable_spec', () => {
    const before = agent({ spec: { model: 'm1', version: '1.0.0' } });
    const after = agent({ spec: { model: 'm2', version: '1.0.0' } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent_immutable_spec');
      expect(result.message).toContain('agent.mutation_refused');
      expect(result.message).toContain('immutable');
      expect(result.message).toContain('1.0.0');
    }
  });

  it('refuses changes to a nested spec field', () => {
    const before = agent({ spec: { model: 'm1', tools: ['a'] } });
    const after = agent({ spec: { model: 'm1', tools: ['b'] } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(false);
  });

  it('allows the published: false → true flip (canonical publication)', () => {
    const before = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'false' } });
    const after = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(true);
  });

  it('allows the absent → true flip', () => {
    const before = agent({});
    const after = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(true);
  });

  it('refuses the published: true → false flip (un-publishing not allowed)', () => {
    const before = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const after = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'false' } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent_published_unflip');
      expect(result.message).toContain('un-published');
    }
  });

  it('refuses the published: true → absent flip', () => {
    const before = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const after = agent({});
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('agent_published_unflip');
  });

  it('allows label additions / removals freely', () => {
    const before: VersionedAgent = {
      metadata: { name: 'a', namespace: 'default' },
      spec: { model: 'm1' },
    };
    const after: VersionedAgent = {
      metadata: { name: 'a', namespace: 'default', labels: { team: 'alpha' } },
      spec: { model: 'm1' },
    };
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(true);
  });

  it('allows other-annotation additions (deprecation marker is a benign add)', () => {
    const before = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const after = agent({
      annotations: {
        [PUBLISHED_ANNOTATION]: 'true',
        'kagent.knuteson.io/deprecated': 'true',
      },
    });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(true);
  });

  it('treats published: TRUE (case-insensitive) the same as true', () => {
    const before = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'TRUE' } });
    const after = agent({ annotations: { [PUBLISHED_ANNOTATION]: 'true' } });
    const result = validateAgentMutation(before, after);
    expect(result.ok).toBe(true);
  });
});

describe('reviewAgentAdmission (AdmissionReview adapter)', () => {
  function review(
    operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'CONNECT',
    oldObject: VersionedAgent | null,
    newObject: VersionedAgent | null,
  ): AdmissionReviewRequest {
    return {
      apiVersion: 'admission.k8s.io/v1',
      kind: 'AdmissionReview',
      request: {
        uid: 'fixture-uid',
        operation,
        oldObject,
        object: newObject,
      },
    };
  }

  it('allows CREATE unconditionally', () => {
    const resp = reviewAgentAdmission(review('CREATE', null, agent({})));
    expect(resp.response.allowed).toBe(true);
    expect(resp.response.uid).toBe('fixture-uid');
  });

  it('allows DELETE unconditionally', () => {
    const resp = reviewAgentAdmission(review('DELETE', agent({}), null));
    expect(resp.response.allowed).toBe(true);
  });

  it('allows CONNECT unconditionally', () => {
    const resp = reviewAgentAdmission(review('CONNECT', null, null));
    expect(resp.response.allowed).toBe(true);
  });

  it('runs validateAgentMutation on UPDATE', () => {
    const before = agent({ spec: { model: 'm1' } });
    const after = agent({ spec: { model: 'm2' } });
    const resp = reviewAgentAdmission(review('UPDATE', before, after));
    expect(resp.response.allowed).toBe(false);
    expect(resp.response.status?.code).toBe(403);
    expect(resp.response.status?.message).toContain('agent.mutation_refused');
  });

  it('default-allows UPDATE with malformed payload (missing oldObject)', () => {
    const resp = reviewAgentAdmission(review('UPDATE', null, agent({})));
    expect(resp.response.allowed).toBe(true);
  });

  it('echoes the inbound apiVersion + uid', () => {
    const req: AdmissionReviewRequest = {
      apiVersion: 'admission.k8s.io/v1beta1',
      kind: 'AdmissionReview',
      request: {
        uid: 'echo-uid',
        operation: 'CREATE',
        oldObject: null,
        object: null,
      },
    };
    const resp = reviewAgentAdmission(req);
    expect(resp.apiVersion).toBe('admission.k8s.io/v1beta1');
    expect(resp.response.uid).toBe('echo-uid');
  });
});

describe('isStructurallyEqual', () => {
  it('handles primitive equality', () => {
    expect(isStructurallyEqual(1, 1)).toBe(true);
    expect(isStructurallyEqual('a', 'a')).toBe(true);
    expect(isStructurallyEqual(null, null)).toBe(true);
    expect(isStructurallyEqual(true, true)).toBe(true);
    expect(isStructurallyEqual(undefined, undefined)).toBe(true);
  });

  it('rejects mismatched primitives', () => {
    expect(isStructurallyEqual(1, '1')).toBe(false);
    expect(isStructurallyEqual(null, undefined)).toBe(false);
    expect(isStructurallyEqual(true, 1)).toBe(false);
  });

  it('handles arrays in order', () => {
    expect(isStructurallyEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(isStructurallyEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(isStructurallyEqual([], [])).toBe(true);
  });

  it('handles nested objects regardless of key order', () => {
    const a = { x: 1, y: { z: [1, 2] } };
    const b = { y: { z: [1, 2] }, x: 1 };
    expect(isStructurallyEqual(a, b)).toBe(true);
  });

  it('treats arrays != objects', () => {
    expect(isStructurallyEqual([], {})).toBe(false);
  });

  it('compares missing-key vs explicit-undefined-key as different', () => {
    expect(isStructurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
