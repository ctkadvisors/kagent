/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for the `buildWorkspaceMounts` helper — Wave 1 / Workspace
 * sub-team. Co-located in `packages/operator/src/` (sibling to
 * `job-spec.test.ts`) so the existing coverage gates apply.
 */

import { describe, expect, it } from 'vitest';

import type { Agent, AgentTask, InputDecl } from './crds/index.js';
import { API_GROUP_VERSION } from './crds/index.js';
import {
  buildWorkspaceMounts,
  WORKSPACE_VOLUME_PREFIX,
  type BuildWorkspaceMountsInput,
} from './job-spec.js';

const baseAgent = (inputs: readonly InputDecl[]): Agent => ({
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    inputs,
  },
});

const taskWithBindings = (
  bindings: readonly { name: string; from: { workspace: string } }[],
): AgentTask => ({
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentTask',
  metadata: { name: 't1', namespace: 'default', uid: 'task-uid-12345' },
  spec: {
    targetAgent: 'researcher',
    payload: {},
    inputs: bindings,
  },
});

describe('buildWorkspaceMounts', () => {
  it('returns empty arrays when Agent declares no inputs', () => {
    const out = buildWorkspaceMounts({
      agent: baseAgent([]),
      task: taskWithBindings([{ name: 'corpus', from: { workspace: 'corpus' } }]),
      resolveWorkspacePvcName: () => 'corpus',
    });
    expect(out.volumes).toEqual([]);
    expect(out.volumeMounts).toEqual([]);
  });

  it('returns empty arrays when AgentTask binds nothing', () => {
    const out = buildWorkspaceMounts({
      agent: baseAgent([{ name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' }]),
      task: { ...taskWithBindings([]), spec: { targetAgent: 'researcher', payload: {} } },
      resolveWorkspacePvcName: () => 'corpus',
    });
    expect(out.volumes).toEqual([]);
    expect(out.volumeMounts).toEqual([]);
  });

  it('skips non-workspace inputs (artifact / scalar)', () => {
    const agent = baseAgent([
      { name: 'document', kind: 'artifact', mountPath: '/work/doc' },
      { name: 'topic', kind: 'scalar' },
      { name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' },
    ]);
    const task = taskWithBindings([{ name: 'corpus', from: { workspace: 'corpus-ws' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumes).toHaveLength(1);
    expect(out.volumeMounts).toHaveLength(1);
    expect(out.volumes[0]?.persistentVolumeClaim?.claimName).toBe('corpus-pvc');
  });

  it('emits readOnly=true by default (mode unset)', () => {
    const agent = baseAgent([{ name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' }]);
    const task = taskWithBindings([{ name: 'corpus', from: { workspace: 'corpus' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumeMounts[0]?.readOnly).toBe(true);
    expect(out.volumes[0]?.persistentVolumeClaim?.readOnly).toBe(true);
  });

  it('honors mode: ro explicitly', () => {
    const agent = baseAgent([
      { name: 'corpus', kind: 'workspace', mountPath: '/work/corpus', mode: 'ro' },
    ]);
    const task = taskWithBindings([{ name: 'corpus', from: { workspace: 'corpus' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumeMounts[0]?.readOnly).toBe(true);
  });

  it('honors mode: rw — readOnly=false on mount, no readOnly on volume', () => {
    const agent = baseAgent([
      { name: 'scratch', kind: 'workspace', mountPath: '/work/scratch', mode: 'rw' },
    ]);
    const task = taskWithBindings([{ name: 'scratch', from: { workspace: 'scratch-ws' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'scratch-pvc',
    });
    expect(out.volumeMounts[0]?.readOnly).toBe(false);
    expect(out.volumes[0]?.persistentVolumeClaim?.readOnly).toBeUndefined();
  });

  it('skips a binding whose Agent decl has no mountPath', () => {
    // Authoring bug: workspace decl with no mountPath. CRD-level
    // admission forbids this; helper still skips defensively.
    const agent = baseAgent([
      // intentional missing mountPath
      { name: 'corpus', kind: 'workspace' },
    ]);
    const task = taskWithBindings([{ name: 'corpus', from: { workspace: 'corpus' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumes).toEqual([]);
    expect(out.volumeMounts).toEqual([]);
  });

  it('skips when the resolver returns undefined (workspace not Ready)', () => {
    const agent = baseAgent([{ name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' }]);
    const task = taskWithBindings([{ name: 'corpus', from: { workspace: 'pending-ws' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => undefined,
    });
    expect(out.volumes).toEqual([]);
    expect(out.volumeMounts).toEqual([]);
  });

  it('skips a binding whose from is not a workspace shape', () => {
    const agent = baseAgent([{ name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' }]);
    // Bindings index is by name; this AgentTask binds `corpus` to a
    // taskUid+output (not a workspace) — the helper must not match it.
    const task: AgentTask = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't1', namespace: 'default', uid: 'task-uid-12345' },
      spec: {
        targetAgent: 'researcher',
        payload: {},
        inputs: [{ name: 'corpus', from: { taskUid: 'parent-uid', output: 'index' } }],
      },
    };
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumes).toEqual([]);
    expect(out.volumeMounts).toEqual([]);
  });

  it('emits one mount per workspace input (multiple bindings)', () => {
    const agent = baseAgent([
      { name: 'corpus', kind: 'workspace', mountPath: '/work/corpus' },
      { name: 'cache', kind: 'workspace', mountPath: '/work/cache', mode: 'rw' },
    ]);
    const task = taskWithBindings([
      { name: 'corpus', from: { workspace: 'corpus-ws' } },
      { name: 'cache', from: { workspace: 'cache-ws' } },
    ]);
    const resolved: Record<string, string> = {
      'corpus-ws': 'corpus-pvc',
      'cache-ws': 'cache-pvc',
    };
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: (n) => resolved[n],
    });
    expect(out.volumes).toHaveLength(2);
    expect(out.volumeMounts).toHaveLength(2);
    const corpusMount = out.volumeMounts.find((m) => m.mountPath === '/work/corpus');
    const cacheMount = out.volumeMounts.find((m) => m.mountPath === '/work/cache');
    expect(corpusMount?.readOnly).toBe(true);
    expect(cacheMount?.readOnly).toBe(false);
  });

  it('volume names use kws- prefix and sanitize illegal characters', () => {
    const agent = baseAgent([
      // Underscore is illegal in K8s volume names; sanitizer must
      // replace it with '-' (and lowercase any uppercase chars).
      { name: 'My_Corpus', kind: 'workspace', mountPath: '/work/corpus' },
    ]);
    const task = taskWithBindings([{ name: 'My_Corpus', from: { workspace: 'corpus-ws' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'corpus-pvc',
    });
    expect(out.volumes[0]?.name).toMatch(new RegExp(`^${WORKSPACE_VOLUME_PREFIX}`));
    expect(out.volumes[0]?.name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(out.volumes[0]?.name).toBe('kws-my-corpus');
  });

  it('truncates long binding names to fit the K8s 63-char volume cap', () => {
    const longName = 'a'.repeat(100);
    const agent = baseAgent([{ name: longName, kind: 'workspace', mountPath: '/work/long' }]);
    const task = taskWithBindings([{ name: longName, from: { workspace: 'long-ws' } }]);
    const out = buildWorkspaceMounts({
      agent,
      task,
      resolveWorkspacePvcName: () => 'long-pvc',
    });
    expect(out.volumes[0]?.name.length).toBeLessThanOrEqual(63);
    expect(out.volumes[0]?.name.startsWith(WORKSPACE_VOLUME_PREFIX)).toBe(true);
  });

  it('does not collide with the artifact-volume name (CAS sub-team coordination)', () => {
    // The artifact volume name is `artifacts` (job-spec.ts
    // ARTIFACT_VOLUME_NAME). The workspace prefix `kws-` prevents
    // collision even if a workspace is literally named `artifacts`.
    const agent = baseAgent([
      { name: 'artifacts', kind: 'workspace', mountPath: '/work/artifacts' },
    ]);
    const task = taskWithBindings([{ name: 'artifacts', from: { workspace: 'artifacts-ws' } }]);
    const out: BuildWorkspaceMountsInput = {
      agent,
      task,
      resolveWorkspacePvcName: () => 'artifacts-pvc',
    };
    const result = buildWorkspaceMounts(out);
    expect(result.volumes[0]?.name).toBe('kws-artifacts');
    expect(result.volumes[0]?.name).not.toBe('artifacts');
  });
});
