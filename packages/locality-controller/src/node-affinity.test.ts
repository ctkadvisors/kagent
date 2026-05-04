/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { V1PersistentVolume, V1PersistentVolumeClaim } from '@kubernetes/client-node';

import { deriveNodeAffinity } from './node-affinity.js';
import type { AffinityAgent, AffinityTask, Workspace, WorkspaceLookup } from './index.js';

function makeAgent(inputs: AffinityAgent['spec']['inputs']): AffinityAgent {
  return {
    metadata: { name: 'test-agent', namespace: 'default' },
    spec: { ...(inputs !== undefined && { inputs }) },
  };
}

function makeTask(
  bindings: { readonly name: string; readonly from: Record<string, unknown> }[],
): AffinityTask {
  return {
    metadata: { name: 'task-1', namespace: 'default', uid: 'uid-1' },
    spec: { inputs: bindings },
  };
}

function makeWorkspace(name: string, pvcName: string, bytesUsed?: number): Workspace {
  return {
    metadata: { name, namespace: 'default', uid: `ws-uid-${name}` },
    status: {
      pvcName,
      ...(bytesUsed !== undefined && { bytesUsed }),
    },
  };
}

function makePvc(name: string, pvName: string): V1PersistentVolumeClaim {
  return {
    metadata: { name, namespace: 'default' },
    spec: { volumeName: pvName },
  };
}

function makePv(name: string, hostname: string): V1PersistentVolume {
  return {
    metadata: { name },
    spec: {
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'kubernetes.io/hostname', operator: 'In', values: [hostname] },
              ],
            },
          ],
        },
      },
    },
  };
}

function makeLookup(args: {
  workspaces?: readonly Workspace[];
  pvcs?: readonly V1PersistentVolumeClaim[];
  pvs?: readonly V1PersistentVolume[];
}): WorkspaceLookup {
  const wsMap = new Map<string, Workspace>();
  for (const w of args.workspaces ?? []) {
    wsMap.set(`${w.metadata.namespace ?? 'default'}/${w.metadata.name ?? ''}`, w);
  }
  const pvcMap = new Map<string, V1PersistentVolumeClaim>();
  for (const p of args.pvcs ?? []) {
    pvcMap.set(`${p.metadata?.namespace ?? 'default'}/${p.metadata?.name ?? ''}`, p);
  }
  const pvMap = new Map<string, V1PersistentVolume>();
  for (const p of args.pvs ?? []) {
    pvMap.set(p.metadata?.name ?? '', p);
  }
  return {
    workspace: (n, ns) => wsMap.get(`${ns}/${n}`),
    pvc: (n, ns) => pvcMap.get(`${ns}/${n}`),
    pv: (n) => pvMap.get(n),
  };
}

describe('deriveNodeAffinity', () => {
  it('returns undefined when Agent declares no inputs', () => {
    const agent = makeAgent(undefined);
    const task = makeTask([]);
    const result = deriveNodeAffinity(agent, task, makeLookup({}));
    expect(result).toBeUndefined();
  });

  it('returns undefined when no workspace bindings on the task', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { scalar: 'x' } }]);
    const result = deriveNodeAffinity(agent, task, makeLookup({}));
    expect(result).toBeUndefined();
  });

  it('returns undefined when Workspace lookup misses', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'absent-ws' } }]);
    const result = deriveNodeAffinity(agent, task, makeLookup({}));
    expect(result).toBeUndefined();
  });

  it('returns undefined when Workspace lacks status.pvcName (not Ready)', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'pending-ws' } }]);
    const lookup = makeLookup({
      workspaces: [
        {
          metadata: { name: 'pending-ws', namespace: 'default' },
          status: { bytesUsed: 0 },
        },
      ],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('returns undefined when PVC lookup misses', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a')],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('returns undefined when PVC unbound (no spec.volumeName)', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pvc: V1PersistentVolumeClaim = {
      metadata: { name: 'ws-a', namespace: 'default' },
      spec: {},
    };
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a')],
      pvcs: [pvc],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('returns undefined when PV lacks nodeAffinity', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pv: V1PersistentVolume = {
      metadata: { name: 'pv-a' },
      spec: {},
    };
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a')],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [pv],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('returns undefined when nodeSelectorTerms array is empty', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pv: V1PersistentVolume = {
      metadata: { name: 'pv-a' },
      spec: { nodeAffinity: { required: { nodeSelectorTerms: [] } } },
    };
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a')],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [pv],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('skips empty nodeSelectorTerms (no matchExpressions and no matchFields)', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pv: V1PersistentVolume = {
      metadata: { name: 'pv-a' },
      spec: {
        nodeAffinity: {
          required: { nodeSelectorTerms: [{}, { matchExpressions: [] }] },
        },
      },
    };
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a')],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [pv],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeUndefined();
  });

  it('emits requiredDuringSchedulingIgnoredDuringExecution mirroring the PV terms', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a', 1024)],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [makePv('pv-a', 'node-1')],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeDefined();
    expect(
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms,
    ).toEqual([
      {
        matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['node-1'] }],
      },
    ]);
  });

  it('picks the largest workspace by bytesUsed when multiple workspaces are bound', () => {
    const agent = makeAgent([
      { name: 'small', kind: 'workspace' },
      { name: 'big', kind: 'workspace' },
    ]);
    const task = makeTask([
      { name: 'small', from: { workspace: 'ws-small' } },
      { name: 'big', from: { workspace: 'ws-big' } },
    ]);
    const lookup = makeLookup({
      workspaces: [
        makeWorkspace('ws-small', 'ws-small', 100),
        makeWorkspace('ws-big', 'ws-big', 100_000),
      ],
      pvcs: [makePvc('ws-small', 'pv-small'), makePvc('ws-big', 'pv-big')],
      pvs: [makePv('pv-small', 'node-small'), makePv('pv-big', 'node-big')],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    expect(result).toBeDefined();
    const exprs =
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]
        ?.matchExpressions;
    expect(exprs?.[0]?.values).toEqual(['node-big']);
  });

  it('treats undefined bytesUsed as 0 in tie-break', () => {
    const agent = makeAgent([
      { name: 'a', kind: 'workspace' },
      { name: 'b', kind: 'workspace' },
    ]);
    const task = makeTask([
      { name: 'a', from: { workspace: 'ws-a' } },
      { name: 'b', from: { workspace: 'ws-b' } },
    ]);
    const lookup = makeLookup({
      workspaces: [
        makeWorkspace('ws-a', 'ws-a' /* no bytesUsed */),
        makeWorkspace('ws-b', 'ws-b', 5),
      ],
      pvcs: [makePvc('ws-a', 'pv-a'), makePvc('ws-b', 'pv-b')],
      pvs: [makePv('pv-a', 'node-a'), makePv('pv-b', 'node-b')],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    const exprs =
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]
        ?.matchExpressions;
    expect(exprs?.[0]?.values).toEqual(['node-b']);
  });

  it('ignores non-workspace input kinds even when bound', () => {
    const agent = makeAgent([
      { name: 'art', kind: 'artifact' },
      { name: 'src', kind: 'workspace' },
    ]);
    const task = makeTask([
      { name: 'art', from: { workspace: 'ws-not-this' } },
      { name: 'src', from: { workspace: 'ws-real' } },
    ]);
    const lookup = makeLookup({
      workspaces: [
        makeWorkspace('ws-not-this', 'ws-not-this', 999),
        makeWorkspace('ws-real', 'ws-real', 1),
      ],
      pvcs: [makePvc('ws-not-this', 'pv-art'), makePvc('ws-real', 'pv-real')],
      pvs: [makePv('pv-art', 'node-bogus'), makePv('pv-real', 'node-real')],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    const exprs =
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]
        ?.matchExpressions;
    expect(exprs?.[0]?.values).toEqual(['node-real']);
  });

  it('returned terms are deep copies (caller cannot mutate the cache)', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pv = makePv('pv-a', 'node-1');
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a', 1)],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [pv],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    const term =
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0];
    expect(term?.matchExpressions?.[0]?.values).toEqual(['node-1']);
    // Mutate the returned copy and verify the source PV is unchanged.
    term?.matchExpressions?.[0]?.values?.push('mutated');
    expect(
      pv.spec?.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values,
    ).toEqual(['node-1']);
  });

  it('preserves matchFields when present on the PV term', () => {
    const agent = makeAgent([{ name: 'src', kind: 'workspace' }]);
    const task = makeTask([{ name: 'src', from: { workspace: 'ws-a' } }]);
    const pv: V1PersistentVolume = {
      metadata: { name: 'pv-a' },
      spec: {
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-x'] }],
              },
            ],
          },
        },
      },
    };
    const lookup = makeLookup({
      workspaces: [makeWorkspace('ws-a', 'ws-a', 1)],
      pvcs: [makePvc('ws-a', 'pv-a')],
      pvs: [pv],
    });
    const result = deriveNodeAffinity(agent, task, lookup);
    const term =
      result?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0];
    expect(term?.matchFields?.[0]?.values).toEqual(['node-x']);
    expect(term?.matchExpressions).toBeUndefined();
  });
});
