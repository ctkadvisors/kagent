/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  fromKindOrNull,
  hashTaskInputs,
  isFromScalar,
  isFromTaskUidOutput,
  isFromWorkspace,
  outputsByName,
  validateInputBindings,
} from './agent-task.js';
import type { Agent, AgentSpec, InputFrom } from './types.js';
import { API_GROUP_VERSION } from './types.js';

const baseAgent: AgentSpec = {
  model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
};

describe('binding-shape predicates', () => {
  it('isFromWorkspace narrows the workspace branch', () => {
    const f: InputFrom = { workspace: 'ws-1' };
    expect(isFromWorkspace(f)).toBe(true);
    expect(isFromTaskUidOutput(f)).toBe(false);
    expect(isFromScalar(f)).toBe(false);
  });

  it('isFromTaskUidOutput narrows the upstream branch', () => {
    const f: InputFrom = { taskUid: 'uid-1', output: 'digest' };
    expect(isFromTaskUidOutput(f)).toBe(true);
    expect(isFromWorkspace(f)).toBe(false);
    expect(isFromScalar(f)).toBe(false);
  });

  it('isFromScalar narrows the inline-literal branch', () => {
    const f: InputFrom = { scalar: 42 };
    expect(isFromScalar(f)).toBe(true);
    expect(isFromWorkspace(f)).toBe(false);
    expect(isFromTaskUidOutput(f)).toBe(false);
  });
});

describe('fromKindOrNull (admission discriminant)', () => {
  it('returns each branch on a well-formed binding', () => {
    expect(fromKindOrNull({ workspace: 'w' })).toBe('workspace');
    expect(fromKindOrNull({ taskUid: 'u', output: 'o' })).toBe('taskUid');
    expect(fromKindOrNull({ scalar: 'x' })).toBe('scalar');
  });

  it('rejects multiple discriminants set (oneOf violation)', () => {
    expect(
      fromKindOrNull({ workspace: 'w', taskUid: 'u', output: 'o' }),
    ).toBe(null);
  });

  it('rejects zero discriminants set', () => {
    expect(fromKindOrNull({} as unknown as InputFrom)).toBe(null);
  });

  it('rejects null / non-object', () => {
    expect(fromKindOrNull(null as unknown as InputFrom)).toBe(null);
  });

  it('rejects taskUid without output (incomplete binding)', () => {
    expect(fromKindOrNull({ taskUid: 'u' } as unknown as InputFrom)).toBe(null);
  });
});

describe('validateInputBindings', () => {
  const agent: Agent = {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name: 'a' },
    spec: {
      ...baseAgent,
      inputs: [
        { name: 'corpus', kind: 'workspace', mountPath: '/var/in/corpus' },
        { name: 'brief', kind: 'artifact', mountPath: '/var/in/brief' },
        { name: 'mode', kind: 'scalar', optional: true },
      ],
    },
  };

  it('accepts a task that binds every required input', () => {
    const result = validateInputBindings(agent, {
      payload: {},
      inputs: [
        { name: 'corpus', from: { workspace: 'ws-1' } },
        { name: 'brief', from: { taskUid: 'uid-1', output: 'brief' } },
      ],
    });
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.malformed).toEqual([]);
  });

  it('flags missing required inputs', () => {
    const result = validateInputBindings(agent, {
      payload: {},
      inputs: [{ name: 'corpus', from: { workspace: 'ws-1' } }],
    });
    expect(result.missing).toEqual(['brief']);
  });

  it('does not require optional inputs', () => {
    const result = validateInputBindings(agent, {
      payload: {},
      inputs: [
        { name: 'corpus', from: { workspace: 'ws-1' } },
        { name: 'brief', from: { taskUid: 'u', output: 'b' } },
      ],
    });
    expect(result.missing).toEqual([]);
  });

  it('flags malformed bindings (zero or multiple from-discriminants)', () => {
    const result = validateInputBindings(agent, {
      payload: {},
      inputs: [
        { name: 'corpus', from: {} as InputFrom },
        { name: 'brief', from: { workspace: 'w', taskUid: 'u', output: 'o' } },
      ],
    });
    expect(result.malformed).toEqual(['corpus', 'brief']);
  });

  it('flags unknown binding names (typo / drift from Agent.spec.inputs)', () => {
    const result = validateInputBindings(agent, {
      payload: {},
      inputs: [
        { name: 'corpus', from: { workspace: 'w' } },
        { name: 'brief', from: { taskUid: 'u', output: 'b' } },
        { name: 'mistyped', from: { scalar: 1 } },
      ],
    });
    expect(result.unknown).toEqual(['mistyped']);
  });

  it('back-compat: a v0.1 Agent without inputs[] accepts a v0.1 AgentTask without inputs[]', () => {
    const v01agent: Agent = {
      apiVersion: API_GROUP_VERSION,
      kind: 'Agent',
      metadata: { name: 'legacy' },
      spec: baseAgent,
    };
    const result = validateInputBindings(v01agent, {
      payload: { x: 1 },
    });
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});

describe('hashTaskInputs (idempotency-cache discriminator)', () => {
  it('produces stable hashes regardless of binding order', () => {
    const a = hashTaskInputs({
      payload: { x: 1 },
      inputs: [
        { name: 'a', from: { workspace: 'w1' } },
        { name: 'b', from: { scalar: 2 } },
      ],
    });
    const b = hashTaskInputs({
      payload: { x: 1 },
      inputs: [
        { name: 'b', from: { scalar: 2 } },
        { name: 'a', from: { workspace: 'w1' } },
      ],
    });
    expect(a).toBe(b);
  });

  it('produces stable hashes regardless of payload key order', () => {
    const a = hashTaskInputs({ payload: { x: 1, y: 2 } });
    const b = hashTaskInputs({ payload: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('produces different hashes for different bindings', () => {
    const a = hashTaskInputs({
      payload: {},
      inputs: [{ name: 'a', from: { workspace: 'w1' } }],
    });
    const b = hashTaskInputs({
      payload: {},
      inputs: [{ name: 'a', from: { workspace: 'w2' } }],
    });
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different payloads', () => {
    const a = hashTaskInputs({ payload: { x: 1 } });
    const b = hashTaskInputs({ payload: { x: 2 } });
    expect(a).not.toBe(b);
  });
});

describe('outputsByName', () => {
  it('returns empty when no refs', () => {
    expect(outputsByName(undefined).size).toBe(0);
    expect(outputsByName([]).size).toBe(0);
  });

  it('indexes refs by name', () => {
    const m = outputsByName([
      { name: 'digest', ref: 'cas://sha256:abc/digest.md' },
      { name: 'meta', ref: 'cas://sha256:def/meta.json' },
    ]);
    expect(m.get('digest')).toBe('cas://sha256:abc/digest.md');
    expect(m.get('meta')).toBe('cas://sha256:def/meta.json');
  });

  it('skips entries with malformed name/ref (defensive)', () => {
    const m = outputsByName([
      { name: '', ref: 'x' },
      { name: 'ok', ref: 'cas://x' },
    ] as { name: string; ref: string }[]);
    expect(m.has('')).toBe(false);
    expect(m.get('ok')).toBe('cas://x');
  });
});
