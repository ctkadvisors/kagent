/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildResourceQuotaForTenant,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  QUOTA_SOURCE_ANNOTATION,
  QUOTA_SOURCE_VALUE,
  resourceQuotaNameForTenant,
  resourceQuotaSpecDiffers,
  TENANT_LABEL,
} from './resource-quota.js';
import type { TenantShape } from './types.js';

function makeTenant(name: string, partial: Partial<TenantShape['spec']> = {}): TenantShape {
  return {
    metadata: { name },
    spec: {
      name,
      namespaceAllowlist: ['ns-a'],
      ...partial,
    },
  };
}

describe('resourceQuotaNameForTenant', () => {
  it('uses kagent-tenant-<name> convention', () => {
    expect(resourceQuotaNameForTenant('alpha')).toBe('kagent-tenant-alpha');
  });
});

describe('buildResourceQuotaForTenant', () => {
  it('returns undefined when tenant declares no quota', () => {
    const t = makeTenant('alpha');
    expect(buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' })).toBeUndefined();
  });

  it('returns undefined when defaultQuota.compute is omitted', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { gateway: { inFlightCap: 5 } },
    });
    expect(buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' })).toBeUndefined();
  });

  it('returns undefined when compute is empty (no fields declared)', () => {
    const t = makeTenant('alpha', { defaultQuota: { compute: {} } });
    expect(buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' })).toBeUndefined();
  });

  it('translates cpuRequests to requests.cpu', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { cpuRequests: '10' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.spec?.hard).toEqual({ 'requests.cpu': '10' });
  });

  it('translates memoryRequests to requests.memory', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { memoryRequests: '20Gi' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.spec?.hard).toEqual({ 'requests.memory': '20Gi' });
  });

  it('translates maxPods to count/pods (string-encoded)', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { maxPods: 50 } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.spec?.hard).toEqual({ 'count/pods': '50' });
  });

  it('combines all three fields into a single ResourceQuota', () => {
    const t = makeTenant('alpha', {
      defaultQuota: {
        compute: { cpuRequests: '10', memoryRequests: '20Gi', maxPods: 50 },
      },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.spec?.hard).toEqual({
      'requests.cpu': '10',
      'requests.memory': '20Gi',
      'count/pods': '50',
    });
  });

  it('stamps standard labels + annotation for forensics', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { cpuRequests: '10' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.metadata?.labels).toEqual({
      [TENANT_LABEL]: 'alpha',
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    });
    expect(rq?.metadata?.annotations).toEqual({
      [QUOTA_SOURCE_ANNOTATION]: QUOTA_SOURCE_VALUE,
    });
  });

  it('uses kagent-tenant-<name> naming + target namespace', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { cpuRequests: '10' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.metadata?.name).toBe('kagent-tenant-alpha');
    expect(rq?.metadata?.namespace).toBe('ns-a');
  });

  it('falls back to spec.name when metadata.name is absent', () => {
    const t: TenantShape = {
      metadata: {},
      spec: {
        name: 'beta',
        namespaceAllowlist: ['ns-b'],
        defaultQuota: { compute: { cpuRequests: '5' } },
      },
    };
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-b' });
    expect(rq?.metadata?.name).toBe('kagent-tenant-beta');
  });

  it('skips empty-string cpuRequests', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { cpuRequests: '', memoryRequests: '20Gi' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.spec?.hard).toEqual({ 'requests.memory': '20Gi' });
  });

  it('skips negative maxPods', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { maxPods: -1 } },
    });
    expect(buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' })).toBeUndefined();
  });

  it('emits apiVersion=v1 + kind=ResourceQuota', () => {
    const t = makeTenant('alpha', {
      defaultQuota: { compute: { cpuRequests: '10' } },
    });
    const rq = buildResourceQuotaForTenant({ tenant: t, namespace: 'ns-a' });
    expect(rq?.apiVersion).toBe('v1');
    expect(rq?.kind).toBe('ResourceQuota');
  });
});

describe('resourceQuotaSpecDiffers', () => {
  it('false when both are undefined', () => {
    expect(resourceQuotaSpecDiffers(undefined, undefined)).toBe(false);
  });

  it('true when only one side is undefined', () => {
    expect(resourceQuotaSpecDiffers(undefined, { spec: { hard: { 'requests.cpu': '1' } } })).toBe(
      true,
    );
    expect(resourceQuotaSpecDiffers({ spec: { hard: { 'requests.cpu': '1' } } }, undefined)).toBe(
      true,
    );
  });

  it('false for matching hard maps', () => {
    expect(
      resourceQuotaSpecDiffers(
        { spec: { hard: { 'requests.cpu': '10', 'count/pods': '5' } } },
        { spec: { hard: { 'count/pods': '5', 'requests.cpu': '10' } } },
      ),
    ).toBe(false);
  });

  it('true on value mismatch', () => {
    expect(
      resourceQuotaSpecDiffers(
        { spec: { hard: { 'requests.cpu': '10' } } },
        { spec: { hard: { 'requests.cpu': '20' } } },
      ),
    ).toBe(true);
  });

  it('true on key-set mismatch', () => {
    expect(
      resourceQuotaSpecDiffers(
        { spec: { hard: { 'requests.cpu': '10' } } },
        { spec: { hard: { 'requests.cpu': '10', 'count/pods': '5' } } },
      ),
    ).toBe(true);
  });
});
