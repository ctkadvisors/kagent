/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyNetworkPolicyForAgent,
  deleteNetworkPolicyForAgent,
  TENANT_LABEL_KEY,
  type ApplyEgressDeps,
  type PolicyAppliedEmissionData,
} from './apply.js';
import type { AgentLike, TenantLike } from './types.js';

function makeAgent(overrides?: {
  egress?: AgentLike['spec']['egress'];
  tenantLabel?: string;
}): AgentLike {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'Agent',
    metadata: {
      name: 'researcher',
      namespace: 'acme',
      uid: 'uid-r',
      ...(overrides?.tenantLabel !== undefined && {
        labels: { [TENANT_LABEL_KEY]: overrides.tenantLabel },
      }),
    },
    spec: {
      ...(overrides?.egress !== undefined && { egress: overrides.egress }),
    },
  };
}

interface FakeNetworkingApi {
  createNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
  replaceNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
  deleteNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
}
interface FakeCustomApi {
  createNamespacedCustomObject: ReturnType<typeof vi.fn>;
  replaceNamespacedCustomObject: ReturnType<typeof vi.fn>;
  deleteNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

interface DepsHandle {
  deps: ApplyEgressDeps;
  networkingApi: FakeNetworkingApi;
  customApi: FakeCustomApi;
}

function makeDeps(partial?: Partial<ApplyEgressDeps>): DepsHandle {
  const networkingApi: FakeNetworkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  };
  const customApi: FakeCustomApi = {
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  };
  const deps: ApplyEgressDeps = {
    networkingApi: networkingApi as unknown as ApplyEgressDeps['networkingApi'],
    customApi: customApi as unknown as ApplyEgressDeps['customApi'],
    ciliumDetected: false,
    ...partial,
  };
  return { deps, networkingApi, customApi };
}

describe('applyNetworkPolicyForAgent — mode selection', () => {
  it('uses NetworkPolicy when ciliumDetected is false', async () => {
    const { deps, networkingApi, customApi } = makeDeps();
    const result = await applyNetworkPolicyForAgent(makeAgent(), deps);
    expect(result.mode).toBe('networkpolicy');
    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('uses Cilium CNP when ciliumDetected is true (auto)', async () => {
    const { deps, networkingApi, customApi } = makeDeps({ ciliumDetected: true, mode: 'auto' });
    const result = await applyNetworkPolicyForAgent(makeAgent(), deps);
    expect(result.mode).toBe('cilium');
    expect(customApi.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled();
  });

  it('forces networkpolicy mode regardless of ciliumDetected', async () => {
    const { deps } = makeDeps({ ciliumDetected: true, mode: 'networkpolicy' });
    const result = await applyNetworkPolicyForAgent(makeAgent(), deps);
    expect(result.mode).toBe('networkpolicy');
  });

  it('forces cilium mode regardless of ciliumDetected', async () => {
    const { deps } = makeDeps({ ciliumDetected: false, mode: 'cilium' });
    const result = await applyNetworkPolicyForAgent(makeAgent(), deps);
    expect(result.mode).toBe('cilium');
  });
});

describe('applyNetworkPolicyForAgent — source attribution', () => {
  it('reports source=agent when Agent declares egress', async () => {
    const result = await applyNetworkPolicyForAgent(
      makeAgent({ egress: { cidrs: ['1.1.1.1/32'] } }),
      makeDeps().deps,
    );
    expect(result.source).toBe('agent');
  });

  it('reports source=tenant when only the tenant default applies', async () => {
    const tenant: TenantLike = {
      metadata: { name: 'acme' },
      spec: { name: 'acme', defaultEgress: { allow: ['api.github.com'] } },
    };
    const result = await applyNetworkPolicyForAgent(
      makeAgent({ tenantLabel: 'acme' }),
      makeDeps({ lookupTenant: () => tenant }).deps,
    );
    expect(result.source).toBe('tenant');
  });

  it('reports source=default-deny when neither Agent nor tenant declare', async () => {
    const result = await applyNetworkPolicyForAgent(makeAgent(), makeDeps().deps);
    expect(result.source).toBe('default-deny');
  });
});

describe('applyNetworkPolicyForAgent — conflict-on-create handling', () => {
  it('falls back to replace on 409', async () => {
    const handle = makeDeps();
    handle.networkingApi.createNamespacedNetworkPolicy = vi
      .fn()
      .mockRejectedValueOnce({ code: 409 });
    handle.networkingApi.replaceNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    handle.deps = {
      ...handle.deps,
      networkingApi: handle.networkingApi as unknown as ApplyEgressDeps['networkingApi'],
    };
    const result = await applyNetworkPolicyForAgent(makeAgent(), handle.deps);
    expect(result.applied).toBe(true);
    expect(handle.networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-409 errors', async () => {
    const handle = makeDeps();
    handle.networkingApi.createNamespacedNetworkPolicy = vi
      .fn()
      .mockRejectedValueOnce({ code: 500, message: 'internal' });
    handle.deps = {
      ...handle.deps,
      networkingApi: handle.networkingApi as unknown as ApplyEgressDeps['networkingApi'],
    };
    await expect(applyNetworkPolicyForAgent(makeAgent(), handle.deps)).rejects.toMatchObject({
      code: 500,
    });
  });

  it('falls back to replace on 409 for Cilium CNP', async () => {
    const handle = makeDeps({ ciliumDetected: true });
    handle.customApi.createNamespacedCustomObject = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 409 });
    handle.customApi.replaceNamespacedCustomObject = vi.fn().mockResolvedValue({});
    handle.deps = {
      ...handle.deps,
      customApi: handle.customApi as unknown as ApplyEgressDeps['customApi'],
    };
    const result = await applyNetworkPolicyForAgent(makeAgent(), handle.deps);
    expect(result.mode).toBe('cilium');
    expect(handle.customApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1);
  });
});

describe('applyNetworkPolicyForAgent — audit hook', () => {
  it('invokes onPolicyApplied with the resolution metadata', async () => {
    const captured: PolicyAppliedEmissionData[] = [];
    await applyNetworkPolicyForAgent(
      makeAgent({
        egress: {
          cidrs: ['1.1.1.1/32', '2.2.2.2/32'],
          domains: ['api.github.com'],
          ports: [{ protocol: 'TCP', port: 443 }],
        },
      }),
      makeDeps({
        onPolicyApplied: (data) => {
          captured.push(data);
        },
      }).deps,
    );
    expect(captured.length).toBe(1);
    const e = captured[0];
    expect(e?.cidrCount).toBe(2);
    expect(e?.domainCount).toBe(1);
    expect(e?.portCount).toBe(1);
    expect(e?.source).toBe('agent');
    expect(e?.mode).toBe('networkpolicy');
    expect(e?.policyName).toBe('kagent-egress-researcher');
  });

  it('does not propagate audit hook errors', async () => {
    await expect(
      applyNetworkPolicyForAgent(
        makeAgent(),
        makeDeps({
          onPolicyApplied: () => {
            throw new Error('audit-down');
          },
        }).deps,
      ),
    ).resolves.toMatchObject({ applied: true });
  });
});

describe('deleteNetworkPolicyForAgent', () => {
  it('deletes a NetworkPolicy via networkingApi', async () => {
    const { deps, networkingApi } = makeDeps();
    await deleteNetworkPolicyForAgent(makeAgent(), deps);
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'acme',
      name: 'kagent-egress-researcher',
    });
  });

  it('deletes a CiliumNetworkPolicy via customApi when cilium is detected', async () => {
    const { deps, customApi } = makeDeps({ ciliumDetected: true });
    await deleteNetworkPolicyForAgent(makeAgent(), deps);
    expect(customApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'cilium.io',
        plural: 'ciliumnetworkpolicies',
        name: 'kagent-egress-researcher',
      }),
    );
  });

  it('swallows 404 (already-gone)', async () => {
    const handle = makeDeps();
    handle.networkingApi.deleteNamespacedNetworkPolicy = vi.fn().mockRejectedValue({ code: 404 });
    handle.deps = {
      ...handle.deps,
      networkingApi: handle.networkingApi as unknown as ApplyEgressDeps['networkingApi'],
    };
    await expect(deleteNetworkPolicyForAgent(makeAgent(), handle.deps)).resolves.toBeUndefined();
  });

  it('rethrows non-404 errors', async () => {
    const handle = makeDeps();
    handle.networkingApi.deleteNamespacedNetworkPolicy = vi.fn().mockRejectedValue({ code: 500 });
    handle.deps = {
      ...handle.deps,
      networkingApi: handle.networkingApi as unknown as ApplyEgressDeps['networkingApi'],
    };
    await expect(deleteNetworkPolicyForAgent(makeAgent(), handle.deps)).rejects.toMatchObject({
      code: 500,
    });
  });
});
