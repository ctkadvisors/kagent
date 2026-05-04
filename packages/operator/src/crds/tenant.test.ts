/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  TENANT_LABEL,
  defaultAuditSubject,
  isTenant,
  isTenantFailed,
  isTenantReady,
  resolveTenantIssuer,
  tenantAdmitsNamespace,
  type Tenant,
} from './tenant.js';
import { API_GROUP_VERSION } from './types.js';

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: { name: 'acme', uid: 'uid-acme' },
    spec: {
      name: 'acme',
      namespaceAllowlist: ['acme-prod', 'acme-staging'],
    },
    ...overrides,
  };
}

describe('isTenant', () => {
  it('accepts a well-formed Tenant', () => {
    expect(isTenant(tenant())).toBe(true);
  });

  it('rejects null / non-object inputs', () => {
    expect(isTenant(null)).toBe(false);
    expect(isTenant(undefined)).toBe(false);
    expect(isTenant('tenant')).toBe(false);
    expect(isTenant(42)).toBe(false);
  });

  it('rejects mismatched apiVersion', () => {
    expect(isTenant({ ...tenant(), apiVersion: 'wrong/v1' as never })).toBe(false);
  });

  it('rejects mismatched kind', () => {
    expect(isTenant({ ...tenant(), kind: 'NotTenant' as never })).toBe(false);
  });

  it('rejects missing spec', () => {
    expect(isTenant({ apiVersion: API_GROUP_VERSION, kind: 'Tenant', metadata: {} })).toBe(false);
  });

  it('rejects missing or empty spec.name', () => {
    expect(
      isTenant({
        apiVersion: API_GROUP_VERSION,
        kind: 'Tenant',
        metadata: {},
        spec: { namespaceAllowlist: ['ns-1'] },
      }),
    ).toBe(false);
    expect(
      isTenant({
        apiVersion: API_GROUP_VERSION,
        kind: 'Tenant',
        metadata: {},
        spec: { name: '', namespaceAllowlist: ['ns-1'] },
      }),
    ).toBe(false);
  });

  it('rejects malformed namespaceAllowlist', () => {
    expect(
      isTenant({
        apiVersion: API_GROUP_VERSION,
        kind: 'Tenant',
        metadata: {},
        spec: { name: 'acme', namespaceAllowlist: 'ns-1' as unknown as string[] },
      }),
    ).toBe(false);
    expect(
      isTenant({
        apiVersion: API_GROUP_VERSION,
        kind: 'Tenant',
        metadata: {},
        spec: { name: 'acme', namespaceAllowlist: [42 as unknown as string] },
      }),
    ).toBe(false);
    expect(
      isTenant({
        apiVersion: API_GROUP_VERSION,
        kind: 'Tenant',
        metadata: {},
        spec: { name: 'acme', namespaceAllowlist: [''] },
      }),
    ).toBe(false);
  });
});

describe('TENANT_LABEL', () => {
  it('is the stable cross-version label key', () => {
    expect(TENANT_LABEL).toBe('kagent.knuteson.io/tenant');
  });
});

describe('defaultAuditSubject', () => {
  it('uses the explicit override when set', () => {
    expect(
      defaultAuditSubject(
        tenant({
          spec: {
            name: 'acme',
            namespaceAllowlist: ['acme-prod'],
            auditSubject: 'kagent/tenant-acme',
          },
        }),
      ),
    ).toBe('kagent/tenant-acme');
  });

  it('falls back to "tenant/<name>" when override absent', () => {
    expect(defaultAuditSubject(tenant())).toBe('tenant/acme');
  });

  it('uses spec.name when metadata.name absent', () => {
    expect(
      defaultAuditSubject(
        tenant({
          metadata: {},
        }),
      ),
    ).toBe('tenant/acme');
  });

  it('treats empty-string override as absent', () => {
    expect(
      defaultAuditSubject(
        tenant({
          spec: {
            name: 'acme',
            namespaceAllowlist: ['acme-prod'],
            auditSubject: '',
          },
        }),
      ),
    ).toBe('tenant/acme');
  });
});

describe('isTenantReady', () => {
  it('returns false when status is undefined', () => {
    expect(isTenantReady(tenant())).toBe(false);
  });

  it('returns false when phase is not Ready', () => {
    expect(isTenantReady(tenant({ status: { phase: 'Pending', namespaceCount: 1 } }))).toBe(false);
    expect(isTenantReady(tenant({ status: { phase: 'Failed', namespaceCount: 1 } }))).toBe(false);
  });

  it('returns false when namespaceCount is 0', () => {
    expect(isTenantReady(tenant({ status: { phase: 'Ready', namespaceCount: 0 } }))).toBe(false);
    expect(isTenantReady(tenant({ status: { phase: 'Ready' } }))).toBe(false);
  });

  it('returns true when phase=Ready AND namespaceCount >= 1', () => {
    expect(isTenantReady(tenant({ status: { phase: 'Ready', namespaceCount: 1 } }))).toBe(true);
    expect(isTenantReady(tenant({ status: { phase: 'Ready', namespaceCount: 5 } }))).toBe(true);
  });
});

describe('isTenantFailed', () => {
  it('returns true only when phase=Failed', () => {
    expect(isTenantFailed(tenant({ status: { phase: 'Failed' } }))).toBe(true);
    expect(isTenantFailed(tenant({ status: { phase: 'Ready' } }))).toBe(false);
    expect(isTenantFailed(tenant({ status: { phase: 'Pending' } }))).toBe(false);
    expect(isTenantFailed(tenant())).toBe(false);
  });
});

describe('resolveTenantIssuer', () => {
  it('returns undefined when capabilityRoot.issuer absent', () => {
    expect(resolveTenantIssuer(tenant())).toBeUndefined();
    expect(
      resolveTenantIssuer(
        tenant({
          spec: {
            name: 'acme',
            namespaceAllowlist: ['acme-prod'],
            capabilityRoot: {},
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('returns the override when set', () => {
    expect(
      resolveTenantIssuer(
        tenant({
          spec: {
            name: 'acme',
            namespaceAllowlist: ['acme-prod'],
            capabilityRoot: { issuer: 'kagent.knuteson.io/operator/acme' },
          },
        }),
      ),
    ).toBe('kagent.knuteson.io/operator/acme');
  });
});

describe('tenantAdmitsNamespace', () => {
  it('returns true when namespace is in the allowlist', () => {
    expect(tenantAdmitsNamespace(tenant(), 'acme-prod')).toBe(true);
    expect(tenantAdmitsNamespace(tenant(), 'acme-staging')).toBe(true);
  });

  it('returns false when namespace is not in the allowlist', () => {
    expect(tenantAdmitsNamespace(tenant(), 'globex-prod')).toBe(false);
    expect(tenantAdmitsNamespace(tenant(), 'default')).toBe(false);
  });

  it('returns false on empty / non-string input', () => {
    expect(tenantAdmitsNamespace(tenant(), '')).toBe(false);
    expect(tenantAdmitsNamespace(tenant(), undefined as unknown as string)).toBe(false);
  });
});
