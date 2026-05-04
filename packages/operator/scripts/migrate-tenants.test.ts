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
} from '../src/crds/index.js';
import {
  computeMigrationPlan,
  parseArgs,
  runMigration,
  type MigrationDeps,
} from './migrate-tenants.js';

function makeAgent(overrides: Partial<Agent['metadata']> = {}): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: {
      name: 'researcher',
      namespace: 'acme-prod',
      labels: { [TENANT_LABEL]: 'acme' },
      ...overrides,
    },
    spec: { model: 'workers-ai/test' },
  };
}

function makeTenant(name: string, namespaces: string[]): Tenant {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `uid-${name}` },
    spec: { name, namespaceAllowlist: namespaces },
  };
}

function makeTask(
  taskName: string,
  agentName: string,
  tenantLabel: string,
  phase = 'Running',
): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: taskName,
      namespace: 'acme-prod',
      uid: `uid-${taskName}`,
      labels: {
        [TENANT_LABEL]: tenantLabel,
        'kagent.knuteson.io/agent': agentName,
      },
    },
    spec: { targetAgent: agentName, payload: {} },
    status: {
      phase: phase as AgentTask['status'] extends infer S ? S : never,
    } as AgentTask['status'],
  };
}

describe('parseArgs', () => {
  it('parses a happy-path move command', () => {
    const args = parseArgs([
      'move',
      'researcher',
      '--from-tenant',
      'acme',
      '--to-tenant',
      'globex',
      '--namespace',
      'acme-prod',
      '--apply',
    ]);
    expect(args).toEqual({
      subcommand: 'move',
      agentName: 'researcher',
      fromTenant: 'acme',
      toTenant: 'globex',
      namespace: 'acme-prod',
      apply: true,
    });
  });

  it('defaults to dry-run when --apply absent', () => {
    const args = parseArgs([
      'move',
      'researcher',
      '--from-tenant',
      'acme',
      '--to-tenant',
      'globex',
    ]);
    expect(args.apply).toBe(false);
    expect(args.namespace).toBe('default');
  });

  it('returns help when no subcommand given', () => {
    expect(parseArgs([]).subcommand).toBe('help');
  });

  it('returns help when subcommand is unknown', () => {
    expect(parseArgs(['frobnicate']).subcommand).toBe('help');
  });
});

describe('computeMigrationPlan', () => {
  it('returns ok=true when target tenant admits the namespace', () => {
    const plan = computeMigrationPlan({
      agent: makeAgent(),
      inFlightTasks: [],
      fromTenant: 'acme',
      toTenant: 'globex',
      toTenantCr: makeTenant('globex', ['acme-prod', 'globex-prod']),
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.agentPatchNeeded).toBe(true);
      expect(plan.taskPatches).toEqual([]);
    }
  });

  it('cascades AgentTask patches that match fromTenant label', () => {
    const plan = computeMigrationPlan({
      agent: makeAgent(),
      inFlightTasks: [
        makeTask('t1', 'researcher', 'acme'),
        makeTask('t2', 'researcher', 'acme'),
        makeTask('t3', 'researcher', 'mystery'), // skipped — different tenant
      ],
      fromTenant: 'acme',
      toTenant: 'globex',
      toTenantCr: makeTenant('globex', ['acme-prod']),
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.taskPatches).toHaveLength(2);
      expect(plan.taskPatches.map((r) => r.name).sort()).toEqual(['t1', 't2']);
    }
  });

  it('refuses with TargetTenantNotFound when toTenantCr undefined', () => {
    const plan = computeMigrationPlan({
      agent: makeAgent(),
      inFlightTasks: [],
      fromTenant: 'acme',
      toTenant: 'mystery',
      toTenantCr: undefined,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe('TargetTenantNotFound');
    }
  });

  it('refuses with TargetNamespaceNotAllowed when target allowlist excludes Agent namespace', () => {
    const plan = computeMigrationPlan({
      agent: makeAgent(),
      inFlightTasks: [],
      fromTenant: 'acme',
      toTenant: 'globex',
      toTenantCr: makeTenant('globex', ['globex-prod-only']),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe('TargetNamespaceNotAllowed');
      expect(plan.message).toContain('globex-prod-only');
    }
  });

  it('refuses with SourceTenantMismatch when current label != fromTenant', () => {
    const plan = computeMigrationPlan({
      agent: makeAgent({ labels: { [TENANT_LABEL]: 'globex' } }),
      inFlightTasks: [],
      fromTenant: 'acme',
      toTenant: 'globex',
      toTenantCr: makeTenant('globex', ['acme-prod']),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe('SourceTenantMismatch');
      expect(plan.message).toContain('globex');
    }
  });

  it('refuses with AgentMissingNamespace when Agent has no namespace', () => {
    const plan = computeMigrationPlan({
      agent: { ...makeAgent({ namespace: undefined }) },
      inFlightTasks: [],
      fromTenant: 'acme',
      toTenant: 'globex',
      toTenantCr: makeTenant('globex', ['acme-prod']),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe('AgentMissingNamespace');
    }
  });
});

describe('runMigration (mocked customApi)', () => {
  function makeDeps(): {
    deps: MigrationDeps;
    customApi: {
      getNamespacedCustomObject: ReturnType<typeof vi.fn>;
      getClusterCustomObject: ReturnType<typeof vi.fn>;
      listNamespacedCustomObject: ReturnType<typeof vi.fn>;
      patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
    };
    emitSpy: ReturnType<typeof vi.fn>;
  } {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeAgent()),
      getClusterCustomObject: vi.fn().mockResolvedValue(makeTenant('globex', ['acme-prod'])),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [makeTask('t1', 'researcher', 'acme'), makeTask('t2', 'researcher', 'acme')],
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    };
    const emitSpy = vi.fn().mockResolvedValue(undefined);
    return {
      deps: {
        customApi: customApi as unknown as MigrationDeps['customApi'],
        emitMigration: emitSpy,
      },
      customApi,
      emitSpy,
    };
  }

  it('dry-run does not patch anything but returns a plan + emits audit', async () => {
    const { deps, customApi, emitSpy } = makeDeps();
    const result = await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'globex',
        namespace: 'acme-prod',
        apply: false,
      },
      deps,
    );
    expect(result.applied).toBe(false);
    expect(result.agentPatched).toBe(false);
    expect(result.tasksPatched).toBe(0);
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(result.plan.ok).toBe(true);
    if (result.plan.ok) {
      expect(result.plan.taskPatches).toHaveLength(2);
    }
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const auditArg = emitSpy.mock.calls[0]?.[0] as { dryRun: boolean; agentTaskCount: number };
    expect(auditArg.dryRun).toBe(true);
    expect(auditArg.agentTaskCount).toBe(2);
  });

  it('applies patches when apply=true', async () => {
    const { deps, customApi } = makeDeps();
    const result = await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'globex',
        namespace: 'acme-prod',
        apply: true,
      },
      deps,
    );
    expect(result.applied).toBe(true);
    expect(result.agentPatched).toBe(true);
    expect(result.tasksPatched).toBe(2);
    // 1 Agent patch + 2 AgentTask patches.
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(3);
  });

  it('refuses when target tenant CR not found', async () => {
    const { deps, customApi } = makeDeps();
    customApi.getClusterCustomObject = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    const result = await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'mystery',
        namespace: 'acme-prod',
        apply: true,
      },
      { ...deps, customApi: customApi as unknown as MigrationDeps['customApi'] },
    );
    expect(result.applied).toBe(false);
    expect(result.plan.ok).toBe(false);
    if (!result.plan.ok) {
      expect(result.plan.reason).toBe('TargetTenantNotFound');
    }
  });

  it('skips terminal AgentTasks (Completed / Failed) from cascade', async () => {
    const { deps, customApi } = makeDeps();
    customApi.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [
        makeTask('t1', 'researcher', 'acme', 'Running'),
        makeTask('t2', 'researcher', 'acme', 'Completed'), // skip
        makeTask('t3', 'researcher', 'acme', 'Failed'), // skip
      ],
    });
    const result = await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'globex',
        namespace: 'acme-prod',
        apply: true,
      },
      { ...deps, customApi: customApi as unknown as MigrationDeps['customApi'] },
    );
    expect(result.applied).toBe(true);
    // Only t1 cascades.
    expect(result.tasksPatched).toBe(1);
  });

  it('continues on per-task patch failures (logs + counts only successes)', async () => {
    const { deps, customApi } = makeDeps();
    let callCount = 0;
    customApi.patchNamespacedCustomObject = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        // First task patch fails; subsequent succeed.
        return Promise.reject(new Error('apiserver-error'));
      }
      return Promise.resolve({});
    });
    const result = await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'globex',
        namespace: 'acme-prod',
        apply: true,
      },
      { ...deps, customApi: customApi as unknown as MigrationDeps['customApi'] },
    );
    expect(result.applied).toBe(true);
    expect(result.agentPatched).toBe(true);
    // Agent patched + 1 task succeeded + 1 task failed.
    expect(result.tasksPatched).toBe(1);
  });

  it('emits audit with actor override', async () => {
    const { deps, emitSpy } = makeDeps();
    await runMigration(
      {
        agentName: 'researcher',
        fromTenant: 'acme',
        toTenant: 'globex',
        namespace: 'acme-prod',
        apply: false,
        actor: 'gh-actions/tenant-bot',
      },
      deps,
    );
    const arg = emitSpy.mock.calls[0]?.[0] as { actor: string };
    expect(arg.actor).toBe('gh-actions/tenant-bot');
  });

  it('swallows audit emission errors (best-effort contract)', async () => {
    const { deps } = makeDeps();
    const broken: MigrationDeps = {
      ...deps,
      emitMigration: vi.fn().mockRejectedValue(new Error('audit-down')),
    };
    await expect(
      runMigration(
        {
          agentName: 'researcher',
          fromTenant: 'acme',
          toTenant: 'globex',
          namespace: 'acme-prod',
          apply: false,
        },
        broken,
      ),
    ).resolves.toBeDefined();
  });
});
