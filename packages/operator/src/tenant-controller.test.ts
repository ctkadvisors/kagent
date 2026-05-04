/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  API_GROUP_VERSION,
  TENANT_LABEL,
  type Agent,
  type AgentTask,
  type Tenant,
} from './crds/index.js';
import {
  computeTenantConditions,
  computeTenantPhase,
  detectNamespaceOverlap,
  mergeTenantCondition,
  reconcileTenant,
  type TenantAuditHooks,
  type TenantLifecycleEmissionData,
  type TenantReconcilerDeps,
} from './tenant-controller.js';

function tenant(
  overrides: Partial<Tenant['spec']> & {
    metaName?: string;
    uid?: string;
    status?: Tenant['status'];
  } = {},
): Tenant {
  const { metaName, uid, status, ...spec } = overrides;
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: {
      name: metaName ?? overrides.name ?? 'acme',
      uid: uid ?? 'uid-acme',
      generation: 1,
    },
    spec: {
      name: 'acme',
      namespaceAllowlist: ['acme-prod'],
      ...spec,
    },
    ...(status !== undefined && { status }),
  };
}

function agent(name: string, tenantLabel: string | undefined): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: {
      name,
      namespace: 'default',
      ...(tenantLabel !== undefined && { labels: { [TENANT_LABEL]: tenantLabel } }),
    },
    spec: { model: 'workers-ai/test' },
  };
}

function task(name: string, tenantLabel: string, phase?: string): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      labels: { [TENANT_LABEL]: tenantLabel },
    },
    spec: { targetAgent: 'researcher', payload: {} },
    ...(phase !== undefined && {
      status: {
        phase: phase as AgentTask['status'] extends infer S ? S : never,
      } as AgentTask['status'],
    }),
  };
}

/* =====================================================================
 * Pure helpers
 * ===================================================================== */

describe('detectNamespaceOverlap', () => {
  it('returns empty when no other tenants exist', () => {
    const ours = tenant();
    expect(detectNamespaceOverlap(ours, [ours])).toEqual([]);
  });

  it('detects overlap with another tenant', () => {
    const ours = tenant({ name: 'acme', namespaceAllowlist: ['shared-ns', 'acme-only'] });
    const other: Tenant = tenant({
      name: 'globex',
      metaName: 'globex',
      uid: 'uid-globex',
      namespaceAllowlist: ['shared-ns', 'globex-only'],
    });
    const overlaps = detectNamespaceOverlap(ours, [ours, other]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({ otherTenant: 'globex', namespace: 'shared-ns' });
  });

  it('skips self-overlap', () => {
    const ours = tenant({ name: 'acme', namespaceAllowlist: ['shared-ns'] });
    const overlaps = detectNamespaceOverlap(ours, [ours]);
    expect(overlaps).toEqual([]);
  });

  it('detects multiple overlapping namespaces', () => {
    const ours = tenant({ name: 'acme', namespaceAllowlist: ['ns1', 'ns2', 'ns3'] });
    const other = tenant({
      name: 'globex',
      metaName: 'globex',
      uid: 'uid-globex',
      namespaceAllowlist: ['ns2', 'ns3', 'ns4'],
    });
    const overlaps = detectNamespaceOverlap(ours, [ours, other]);
    expect(overlaps).toHaveLength(2);
  });
});

describe('computeTenantPhase', () => {
  it('returns Failed when name mismatches metadata.name', () => {
    const t = tenant({ metaName: 'wrong-name' });
    expect(computeTenantPhase({ tenant: t, namespaceCount: 1, overlaps: [] })).toBe('Failed');
  });

  it('returns Failed when overlaps exist', () => {
    const t = tenant();
    const phase = computeTenantPhase({
      tenant: t,
      namespaceCount: 1,
      overlaps: [{ otherTenant: 'globex', namespace: 'shared-ns' }],
    });
    expect(phase).toBe('Failed');
  });

  it('returns Ready when at least one allowlisted ns exists', () => {
    expect(computeTenantPhase({ tenant: tenant(), namespaceCount: 1, overlaps: [] })).toBe('Ready');
  });

  it('returns Pending when no allowlisted ns exists', () => {
    expect(computeTenantPhase({ tenant: tenant(), namespaceCount: 0, overlaps: [] })).toBe(
      'Pending',
    );
  });
});

describe('computeTenantConditions', () => {
  const now = (): Date => new Date('2026-05-04T12:00:00Z');

  it('emits NamespaceAllowlistResolved=True when ns count >= 1', () => {
    const conds = computeTenantConditions(
      { tenant: tenant(), namespaceCount: 1, overlaps: [] },
      now,
    );
    const c = conds.find((c) => c.type === 'NamespaceAllowlistResolved');
    expect(c?.status).toBe('True');
  });

  it('emits NamespaceAllowlistResolved=False when ns count is 0', () => {
    const conds = computeTenantConditions(
      { tenant: tenant(), namespaceCount: 0, overlaps: [] },
      now,
    );
    const c = conds.find((c) => c.type === 'NamespaceAllowlistResolved');
    expect(c?.status).toBe('False');
    expect(c?.reason).toBe('NoExistingNamespace');
  });

  it('emits NamespaceOverlap when overlaps present', () => {
    const conds = computeTenantConditions(
      {
        tenant: tenant(),
        namespaceCount: 1,
        overlaps: [{ otherTenant: 'globex', namespace: 'shared-ns' }],
      },
      now,
    );
    const c = conds.find((c) => c.type === 'NamespaceOverlap');
    expect(c?.status).toBe('True');
    expect(c?.reason).toBe('OverlappingAllowlist');
    expect(c?.message).toContain('globex');
  });

  it('emits NameMismatch when spec.name != metadata.name', () => {
    const conds = computeTenantConditions(
      {
        tenant: tenant({ metaName: 'wrong-name' }),
        namespaceCount: 1,
        overlaps: [],
      },
      now,
    );
    const c = conds.find((c) => c.type === 'NameMismatch');
    expect(c?.status).toBe('True');
  });
});

describe('mergeTenantCondition', () => {
  it('appends when type is new', () => {
    const result = mergeTenantCondition([], {
      type: 'A',
      status: 'True',
      lastTransitionTime: '2026-05-04T12:00:00Z',
    });
    expect(result).toHaveLength(1);
  });

  it('replaces when type matches and content differs', () => {
    const existing = [
      {
        type: 'A',
        status: 'True' as const,
        message: 'old',
        lastTransitionTime: '2026-05-03T00:00:00Z',
      },
    ];
    const result = mergeTenantCondition(existing, {
      type: 'A',
      status: 'False',
      message: 'new',
      lastTransitionTime: '2026-05-04T12:00:00Z',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('False');
    expect(result[0]?.message).toBe('new');
  });

  it('preserves identical condition (lastTransitionTime stays)', () => {
    const existing = [
      {
        type: 'A',
        status: 'True' as const,
        message: 'msg',
        lastTransitionTime: '2026-05-03T00:00:00Z',
      },
    ];
    const result = mergeTenantCondition(existing, {
      type: 'A',
      status: 'True',
      message: 'msg',
      lastTransitionTime: '2026-05-04T12:00:00Z',
    });
    expect(result[0]?.lastTransitionTime).toBe('2026-05-03T00:00:00Z');
  });
});

/* =====================================================================
 * Reconciler — driven against in-memory deps.
 * ===================================================================== */

interface FakeDepsArgs {
  readonly tenants?: readonly Tenant[];
  readonly agentsByTenant?: ReadonlyMap<string, readonly Agent[]>;
  readonly tasksByTenant?: ReadonlyMap<string, readonly AgentTask[]>;
  readonly existingNamespaces?: ReadonlySet<string>;
  readonly audit?: TenantAuditHooks;
  readonly patchSpy?: ReturnType<typeof vi.fn>;
  readonly now?: () => Date;
}

function makeDeps(args: FakeDepsArgs): TenantReconcilerDeps {
  const patchSpy = args.patchSpy ?? vi.fn().mockResolvedValue({});
  return {
    customApi: {
      patchClusterCustomObjectStatus: patchSpy,
    } as unknown as TenantReconcilerDeps['customApi'],
    listTenants: () => args.tenants ?? [],
    listAgentsForTenant: (name) => args.agentsByTenant?.get(name) ?? [],
    listActiveTasksForTenant: (name) => args.tasksByTenant?.get(name) ?? [],
    namespaceExists: (ns) => args.existingNamespaces?.has(ns) ?? false,
    ...(args.audit !== undefined && { audit: args.audit }),
    ...(args.now !== undefined && { now: args.now }),
  };
}

describe('reconcileTenant', () => {
  it('patches Ready when allowlisted namespace exists', async () => {
    const t = tenant();
    const patchSpy = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      patchSpy,
    });
    const result = await reconcileTenant(t, deps);
    expect(result).toEqual({ kind: 'status-patched', phase: 'Ready' });
    expect(patchSpy).toHaveBeenCalledTimes(1);
    const call = patchSpy.mock.calls[0]?.[0] as { body: { status: { phase: string } } };
    expect(call.body.status.phase).toBe('Ready');
    expect((call.body.status as { namespaceCount: number }).namespaceCount).toBe(1);
  });

  it('patches Pending when no allowlisted namespace exists', async () => {
    const t = tenant();
    const deps = makeDeps({ tenants: [t], existingNamespaces: new Set() });
    const result = await reconcileTenant(t, deps);
    expect(result).toEqual({ kind: 'status-patched', phase: 'Pending' });
  });

  it('patches Failed on namespace overlap', async () => {
    const t1 = tenant({ name: 'acme', namespaceAllowlist: ['shared-ns', 'acme-only'] });
    const t2 = tenant({
      name: 'globex',
      metaName: 'globex',
      uid: 'uid-globex',
      namespaceAllowlist: ['shared-ns'],
    });
    const deps = makeDeps({
      tenants: [t1, t2],
      existingNamespaces: new Set(['shared-ns']),
    });
    const result = await reconcileTenant(t1, deps);
    expect(result).toEqual({ kind: 'status-patched', phase: 'Failed' });
  });

  it('counts agents + active tasks correctly', async () => {
    const t = tenant();
    const patchSpy = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      agentsByTenant: new Map([['acme', [agent('a1', 'acme'), agent('a2', 'acme')]]]),
      tasksByTenant: new Map([['acme', [task('t1', 'acme'), task('t2', 'acme')]]]),
      patchSpy,
    });
    await reconcileTenant(t, deps);
    const status = patchSpy.mock.calls[0]?.[0] as {
      body: { status: { agentCount: number; activeTaskCount: number } };
    };
    expect(status.body.status.agentCount).toBe(2);
    expect(status.body.status.activeTaskCount).toBe(2);
  });

  it('emits onCreated audit event on first reconcile (no previous status)', async () => {
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    const t = tenant();
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      audit: { onCreated, onUpdated },
    });
    await reconcileTenant(t, deps);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();
    const arg = onCreated.mock.calls[0]?.[0] as TenantLifecycleEmissionData;
    expect(arg.tenant).toBe('acme');
    expect(arg.phase).toBe('Ready');
    expect(arg.namespaceCount).toBe(1);
  });

  it('emits onUpdated audit event on subsequent reconcile (status present)', async () => {
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    const t = tenant({ status: { phase: 'Ready', namespaceCount: 1 } });
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      audit: { onCreated, onUpdated },
    });
    await reconcileTenant(t, deps);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('emits onDeleted on reconcile with deletionTimestamp', async () => {
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    const t: Tenant = {
      ...tenant({ status: { phase: 'Ready', namespaceCount: 1 } }),
      metadata: {
        name: 'acme',
        uid: 'uid-acme',
        deletionTimestamp: new Date('2026-05-04T12:00:00Z'),
      },
    };
    const deps = makeDeps({
      tenants: [],
      audit: { onDeleted },
    });
    const result = await reconcileTenant(t, deps);
    expect(result).toEqual({ kind: 'deletion-observed', tenantName: 'acme' });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('swallows audit hook errors (best-effort contract)', async () => {
    const onCreated = vi.fn().mockRejectedValue(new Error('boom'));
    const t = tenant();
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      audit: { onCreated },
    });
    // Should not throw.
    await expect(reconcileTenant(t, deps)).resolves.toEqual({
      kind: 'status-patched',
      phase: 'Ready',
    });
  });

  it('swallows status-patch errors (best-effort contract)', async () => {
    const t = tenant();
    const patchSpy = vi.fn().mockRejectedValue(new Error('apiserver-down'));
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      patchSpy,
    });
    await expect(reconcileTenant(t, deps)).resolves.toEqual({
      kind: 'status-patched',
      phase: 'Ready',
    });
  });

  it('only excludes Completed and Failed AgentTasks from activeTaskCount', async () => {
    const t = tenant();
    const patchSpy = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      tenants: [t],
      existingNamespaces: new Set(['acme-prod']),
      tasksByTenant: new Map([
        ['acme', [task('p1', 'acme', 'Pending'), task('r1', 'acme', 'Running')]],
      ]),
      patchSpy,
    });
    await reconcileTenant(t, deps);
    const status = patchSpy.mock.calls[0]?.[0] as {
      body: { status: { activeTaskCount: number } };
    };
    expect(status.body.status.activeTaskCount).toBe(2);
  });
});
