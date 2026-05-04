/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  checkTenantStorage,
  DEFAULT_CAS_WALK_INTERVAL_MS,
  MIN_CAS_WALK_INTERVAL_MS,
  startCasQuotaController,
  walkCasUsageByTenant,
} from './cas-quota.js';
import { STORAGE_REFUSAL_REASON, type TaskShape } from './types.js';

const HASH_A = '0'.repeat(64);
const HASH_B = '1'.repeat(64);
const HASH_C = '2'.repeat(64);

function task(tenant: string | undefined, refs: string[]): TaskShape {
  const labels = tenant !== undefined ? { 'kagent.knuteson.io/tenant': tenant } : {};
  return {
    metadata: { labels },
    status: {
      phase: 'Completed',
      outputs: refs.map((ref) => ({ ref, name: 'o' })),
    },
  };
}

describe('walkCasUsageByTenant', () => {
  const TENANT_LABEL = 'kagent.knuteson.io/tenant';

  it('sums bytes per tenant from CAS-URI outputs', () => {
    const tasks: TaskShape[] = [
      task('alpha', [`cas:sha256:${HASH_A}`]),
      task('alpha', [`cas:sha256:${HASH_B}`]),
      task('beta', [`cas:sha256:${HASH_C}`]),
    ];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.bytesUsed).toBe(2000);
    expect(result.perTenant.get('beta')?.bytesUsed).toBe(1000);
    expect(result.perTenant.get('alpha')?.artifactCount).toBe(2);
    expect(result.perTenant.get('beta')?.artifactCount).toBe(1);
    expect(result.scanned).toBe(3);
  });

  it('dedupes blob hashes within a tenant', () => {
    const tasks: TaskShape[] = [
      task('alpha', [`cas:sha256:${HASH_A}`]),
      task('alpha', [`cas:sha256:${HASH_A}`]), // same hash, second task
      task('alpha', [`cas:sha256:${HASH_B}`]),
    ];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.bytesUsed).toBe(2000);
    expect(result.perTenant.get('alpha')?.artifactCount).toBe(2);
  });

  it('counts the same hash under each tenant separately', () => {
    const tasks: TaskShape[] = [
      task('alpha', [`cas:sha256:${HASH_A}`]),
      task('beta', [`cas:sha256:${HASH_A}`]),
    ];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.bytesUsed).toBe(1000);
    expect(result.perTenant.get('beta')?.bytesUsed).toBe(1000);
  });

  it('skips tasks with no tenant label', () => {
    const tasks: TaskShape[] = [task(undefined, [`cas:sha256:${HASH_A}`])];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.size).toBe(0);
  });

  it('skips non-CAS refs (inline, malformed, missing)', () => {
    const tasks: TaskShape[] = [
      task('alpha', ['inline:abc', `cas:sha256:short`, '', `cas:sha256:${HASH_A}`]),
    ];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.bytesUsed).toBe(1000);
    expect(result.perTenant.get('alpha')?.artifactCount).toBe(1);
  });

  it('skips blobs whose stat returns undefined (missing on disk)', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`, `cas:sha256:${HASH_B}`])];
    let n = 0;
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => {
        n++;
        return n === 1 ? { size: 1000 } : undefined;
      },
    });
    expect(result.perTenant.get('alpha')?.bytesUsed).toBe(1000);
    expect(result.perTenant.get('alpha')?.artifactCount).toBe(1);
    expect(result.scanned).toBe(2);
  });

  it('marks tenant overCap when bytesUsed > cap', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`])];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => 500,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.overCap).toBe(true);
    expect(result.overCap.has('alpha')).toBe(true);
  });

  it('does NOT mark tenant overCap at exactly cap (cap is inclusive)', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`])];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => 1000,
      statFn: () => ({ size: 1000 }),
    });
    expect(result.perTenant.get('alpha')?.overCap).toBe(false);
    expect(result.overCap.has('alpha')).toBe(false);
  });

  it('treats undefined cap as no enforcement', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`])];
    const result = walkCasUsageByTenant({
      tasks,
      mountPath: '/var/kagent/cas',
      tenantLabel: TENANT_LABEL,
      capBytesLookup: () => undefined,
      statFn: () => ({ size: 9_999_999 }),
    });
    expect(result.perTenant.get('alpha')?.overCap).toBe(false);
    expect(result.overCap.has('alpha')).toBe(false);
  });
});

describe('checkTenantStorage', () => {
  it('passes when tenant undefined', () => {
    expect(checkTenantStorage(undefined, new Set(['alpha'])).ok).toBe(true);
  });

  it('passes when tenant is not in over-cap set', () => {
    expect(checkTenantStorage('alpha', new Set()).ok).toBe(true);
  });

  it('refuses when tenant is in over-cap set', () => {
    const r = checkTenantStorage('alpha', new Set(['alpha']));
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toBe(STORAGE_REFUSAL_REASON);
      expect(r.tenant).toBe('alpha');
      expect(r.message).toContain('alpha');
    }
  });
});

describe('startCasQuotaController', () => {
  const TENANT_LABEL = 'kagent.knuteson.io/tenant';

  it('refuses when intervalMs below MIN', () => {
    expect(() =>
      startCasQuotaController(
        { mountPath: '/x', intervalMs: 100, tenantLabel: TENANT_LABEL },
        { listAgentTasks: () => [], capBytesLookup: () => undefined, log: () => {} },
      ),
    ).toThrow(/intervalMs/);
  });

  it('runs initial walk synchronously + populates over-cap set', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`])];
    const handle = startCasQuotaController(
      { mountPath: '/x', intervalMs: MIN_CAS_WALK_INTERVAL_MS, tenantLabel: TENANT_LABEL },
      {
        listAgentTasks: () => tasks,
        capBytesLookup: () => 100,
        log: () => {},
        statFn: () => ({ size: 9_999 }),
      },
    );
    expect(handle.overCap().has('alpha')).toBe(true);
    expect(handle.lastResult()?.scanned).toBe(1);
    handle.stop();
  });

  it('emits storage_exceeded once per over-cap entry per lifecycle', () => {
    const tasks: TaskShape[] = [task('alpha', [`cas:sha256:${HASH_A}`])];
    const emitted: { tenant: string; bytesUsed: number; bytesCap: number }[] = [];
    const handle = startCasQuotaController(
      { mountPath: '/x', intervalMs: MIN_CAS_WALK_INTERVAL_MS, tenantLabel: TENANT_LABEL },
      {
        listAgentTasks: () => tasks,
        capBytesLookup: () => 100,
        emitStorageExceeded: (data) => {
          emitted.push(data);
        },
        log: () => {},
        statFn: () => ({ size: 9_999 }),
      },
    );
    // Initial tick fires once; controller's emitted-set prevents
    // re-fire on subsequent walks while tenant remains over-cap.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.tenant).toBe('alpha');
    expect(emitted[0]?.bytesCap).toBe(100);
    handle.stop();
  });

  it('exposes DEFAULT_CAS_WALK_INTERVAL_MS = 10 minutes', () => {
    expect(DEFAULT_CAS_WALK_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
