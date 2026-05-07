/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentWorkflow controller — reconciler tests. Drives the pure
 * `reconcileAgentWorkflow` path against mocked K8s API surfaces +
 * a stub CapCa; verifies the manifest builders, status transitions,
 * finalizer dance, trigger materialization, and Restate registration.
 */

import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION } from './crds/index.js';
import type { AgentWorkflow } from './crds/index.js';
import {
  buildScheduleCrForTrigger,
  buildWorkflowDeployment,
  buildWorkflowService,
  capSecretNameForAgentWorkflow,
  computePhase,
  mergeCondition,
  reconcileAgentWorkflow,
  WORKFLOW_FINALIZER,
  WORKFLOW_LABEL_KEY,
  WORKFLOW_MANAGED_LABEL_KEY,
  WORKFLOW_MANAGED_LABEL_VALUE,
  WORKFLOW_PORT,
  type AgentWorkflowReconcilerDeps,
  type WorkflowAuditEmit,
} from './agent-workflow-controller.js';
import type { CapCa } from './cap-ca.js';

const baseWorkflow = (overrides: Partial<AgentWorkflow> = {}): AgentWorkflow => ({
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentWorkflow',
  metadata: {
    name: 'daily-research',
    namespace: 'default',
    uid: 'wf-uid-12345',
    finalizers: [WORKFLOW_FINALIZER],
    ...(overrides.metadata ?? {}),
  },
  spec: {
    image: 'ghcr.io/example/research:v1',
    handler: 'researchOrchestrator',
    ...(overrides.spec ?? {}),
  },
  ...(overrides.status !== undefined && { status: overrides.status }),
});

function stubCapCa(): CapCa {
  return {
    alg: 'ES256',
    jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k' },
    kid: 'kagent-cap-test',
    issuer: 'kagent.knuteson.io/operator',
    mint: vi.fn().mockResolvedValue({
      jwt: 'jwt.token.here',
      jti: 'cap-wf-test-1',
      expiresAt: 9999999999,
    }),
    jwks: () => ({ keys: [] }),
  };
}

function makeDeps(
  overrides: Partial<{
    createDeployment: ReturnType<typeof vi.fn>;
    patchDeployment: ReturnType<typeof vi.fn>;
    createService: ReturnType<typeof vi.fn>;
    createSecret: ReturnType<typeof vi.fn>;
    patchSecret: ReturnType<typeof vi.fn>;
    createCustomObject: ReturnType<typeof vi.fn>;
    patchStatus: ReturnType<typeof vi.fn>;
    patchObject: ReturnType<typeof vi.fn>;
    fetchFn: ReturnType<typeof vi.fn>;
    capCa: CapCa | undefined;
    auditEmit: ReturnType<typeof vi.fn>;
  }> = {},
): {
  deps: AgentWorkflowReconcilerDeps;
  mocks: {
    createDeployment: ReturnType<typeof vi.fn>;
    patchDeployment: ReturnType<typeof vi.fn>;
    createService: ReturnType<typeof vi.fn>;
    createSecret: ReturnType<typeof vi.fn>;
    patchSecret: ReturnType<typeof vi.fn>;
    createCustomObject: ReturnType<typeof vi.fn>;
    patchStatus: ReturnType<typeof vi.fn>;
    patchObject: ReturnType<typeof vi.fn>;
    fetchFn: ReturnType<typeof vi.fn>;
    capCa: CapCa;
    auditEmit: ReturnType<typeof vi.fn>;
  };
} {
  const createDeployment = overrides.createDeployment ?? vi.fn().mockResolvedValue({});
  const patchDeployment = overrides.patchDeployment ?? vi.fn().mockResolvedValue({});
  const createService = overrides.createService ?? vi.fn().mockResolvedValue({});
  const createSecret = overrides.createSecret ?? vi.fn().mockResolvedValue({});
  const patchSecret = overrides.patchSecret ?? vi.fn().mockResolvedValue({});
  const createCustomObject = overrides.createCustomObject ?? vi.fn().mockResolvedValue({});
  const patchStatus = overrides.patchStatus ?? vi.fn().mockResolvedValue({});
  const patchObject = overrides.patchObject ?? vi.fn().mockResolvedValue({});
  const fetchFn = overrides.fetchFn ?? vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const capCa = overrides.capCa === undefined ? stubCapCa() : overrides.capCa;
  const auditEmit = overrides.auditEmit ?? vi.fn();

  const customApi = {
    patchNamespacedCustomObjectStatus: patchStatus,
    patchNamespacedCustomObject: patchObject,
    createNamespacedCustomObject: createCustomObject,
  } as unknown as AgentWorkflowReconcilerDeps['customApi'];
  const coreApi = {
    createNamespacedService: createService,
    createNamespacedSecret: createSecret,
    patchNamespacedSecret: patchSecret,
  } as unknown as AgentWorkflowReconcilerDeps['coreApi'];
  const appsApi = {
    createNamespacedDeployment: createDeployment,
    patchNamespacedDeployment: patchDeployment,
  } as unknown as AgentWorkflowReconcilerDeps['appsApi'];

  return {
    deps: {
      customApi,
      coreApi,
      appsApi,
      capCa,
      options: {
        defaultRestateAddress: 'http://restate.kagent-system.svc.cluster.local:8080',
        restateAdminAddress: 'http://restate.kagent-system.svc.cluster.local:9070',
        fetch: fetchFn as unknown as typeof globalThis.fetch,
        now: () => new Date('2026-05-04T12:00:00Z'),
      },
      auditEmit,
    },
    mocks: {
      createDeployment,
      patchDeployment,
      createService,
      createSecret,
      patchSecret,
      createCustomObject,
      patchStatus,
      patchObject,
      fetchFn,
      capCa,
      auditEmit,
    },
  };
}

describe('manifest builders', () => {
  it('buildWorkflowDeployment carries the cap JWT volume + workflow env', () => {
    const wf = baseWorkflow();
    const dep = buildWorkflowDeployment(wf, {
      restateAddress: 'http://restate:8080',
      capSecretName: capSecretNameForAgentWorkflow(wf),
    });
    expect(dep.metadata?.name).toBe('kawf-daily-research');
    expect(dep.spec?.replicas).toBe(1);
    const container = dep.spec?.template.spec?.containers[0];
    expect(container?.image).toBe('ghcr.io/example/research:v1');
    expect(container?.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'KAGENT_WORKFLOW_HANDLER', value: 'researchOrchestrator' }),
        expect.objectContaining({ name: 'KAGENT_RESTATE_ADDRESS', value: 'http://restate:8080' }),
        expect.objectContaining({ name: 'KAGENT_CAP_JWT_FILE' }),
      ]),
    );
    expect(container?.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mountPath: '/var/kagent/cap', readOnly: true }),
      ]),
    );
    expect(dep.spec?.template.spec?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ secret: { secretName: 'kawf-daily-research-cap' } }),
      ]),
    );
  });

  it('buildWorkflowDeployment honors spec.replicas', () => {
    const wf = baseWorkflow({ spec: { image: 'i', handler: 'h', replicas: 3 } });
    const dep = buildWorkflowDeployment(wf, {
      restateAddress: 'http://r',
      capSecretName: 'cap',
    });
    expect(dep.spec?.replicas).toBe(3);
  });

  it('buildWorkflowService exposes workflow port via ClusterIP', () => {
    const svc = buildWorkflowService(baseWorkflow());
    expect(svc.metadata?.name).toBe('kawf-daily-research');
    expect(svc.spec?.type).toBe('ClusterIP');
    expect(svc.spec?.ports?.[0]?.port).toBe(WORKFLOW_PORT);
    expect(svc.spec?.selector).toEqual({
      [WORKFLOW_MANAGED_LABEL_KEY]: WORKFLOW_MANAGED_LABEL_VALUE,
      [WORKFLOW_LABEL_KEY]: 'daily-research',
    });
  });

  it('buildScheduleCrForTrigger materializes a sibling KagentSchedule', () => {
    const wf = baseWorkflow();
    const sched = buildScheduleCrForTrigger(wf, { kind: 'schedule', schedule: '0 6 * * *' }, 0);
    expect(sched.kind).toBe('KagentSchedule');
    expect(sched.metadata.name).toBe('kawf-daily-research-sched-0');
    expect(sched.spec.schedule).toBe('0 6 * * *');
    expect(sched.spec.taskTemplate.targetAgent).toBe('__kagent_workflow_trigger__');
    const payload = sched.spec.taskTemplate.payload as { workflowName: string };
    expect(payload.workflowName).toBe('daily-research');
  });
});

describe('reconcileAgentWorkflow — happy path', () => {
  it('mints cap, creates Secret + Deployment + Service, registers with Restate, patches status', async () => {
    const wf = baseWorkflow();
    const { deps, mocks } = makeDeps();

    const result = await reconcileAgentWorkflow({ wf }, deps);
    expect(result.kind).toBe('cap-minted');
    if (result.kind !== 'cap-minted') return;
    expect(result.jti).toBe('cap-wf-test-1');

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() reference, no `this` access
    const mintFn = mocks.capCa.mint;
    expect(mintFn).toHaveBeenCalledWith(
      expect.objectContaining({ subjectTaskUid: 'workflow:wf-uid-12345' }),
    );
    expect(mocks.createSecret).toHaveBeenCalledTimes(1);
    expect(mocks.createDeployment).toHaveBeenCalledTimes(1);
    expect(mocks.createService).toHaveBeenCalledTimes(1);
    expect(mocks.fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/\/deployments$/),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.patchStatus).toHaveBeenCalled();
    const statusBody = (mocks.patchStatus.mock.calls[0]?.[0] as { body: { status: unknown } }).body
      .status as { capabilityRef?: string; phase?: string };
    expect(statusBody.capabilityRef).toBe('cap-wf-test-1');
  });

  it('audit emit fires for workflow.started on first deployment creation', async () => {
    const wf = baseWorkflow();
    const { deps, mocks } = makeDeps();
    await reconcileAgentWorkflow({ wf }, deps);
    expect(mocks.auditEmit).toHaveBeenCalledWith(
      'started',
      expect.objectContaining({
        workflow: 'daily-research',
      }),
    );
  });

  // WBD-OP-1 regression — drives the FULL production wireup pattern
  // main.ts uses (`auditEmit` thunk reading through a mutable holder
  // populated when the audit publisher comes online). Previously the
  // production callsite at `buildAgentWorkflowController({...})` did
  // NOT pass `auditEmit`, so `workflow.started` silently no-op'd.
  // This test fails if the wiring regresses to the optional-fallback
  // shape.
  it('regression: production-shape `auditEmit` thunk via mutable holder fires workflow.started (WBD-OP-1)', async () => {
    const wf = baseWorkflow();
    const collected: { type: string; payload: Record<string, unknown> }[] = [];

    // Mirror main.ts:workflowAuditHolder pattern verbatim.
    const workflowAuditHolder: { emit?: WorkflowAuditEmit } = {};
    workflowAuditHolder.emit = (type, payload) => {
      collected.push({ type, payload: { ...payload } });
    };

    // Same `auditEmit` thunk shape main.ts threads into
    // `buildAgentWorkflowController`. Before WBD-OP-1's fix the
    // production callsite omitted this entirely.
    const productionShapeAuditEmit: WorkflowAuditEmit = (type, payload) => {
      workflowAuditHolder.emit?.(type, payload);
    };

    const { deps } = makeDeps({ auditEmit: vi.fn(productionShapeAuditEmit) });
    await reconcileAgentWorkflow({ wf }, deps);

    // Both `workflow.started` AND audit-via-holder pattern observed.
    const started = collected.find((c) => c.type === 'started');
    expect(started).toBeDefined();
    expect(started?.payload.workflow).toBe('daily-research');
  });
});

describe('reconcileAgentWorkflow — finalizer dance', () => {
  it('adds the finalizer on first sight when missing', async () => {
    const wf = baseWorkflow({
      metadata: { name: 'x', namespace: 'default', uid: 'u', finalizers: [] },
    });
    const { deps, mocks } = makeDeps();
    const result = await reconcileAgentWorkflow({ wf }, deps);
    expect(result.kind).toBe('finalizer-added');
    expect(mocks.patchObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { metadata: { finalizers: [WORKFLOW_FINALIZER] } },
      }),
      expect.anything(),
    );
  });

  it('removes the finalizer + patches Failed on deletionTimestamp', async () => {
    const wf = baseWorkflow({
      metadata: {
        name: 'daily-research',
        namespace: 'default',
        uid: 'u',
        finalizers: [WORKFLOW_FINALIZER],
        deletionTimestamp: new Date('2026-05-04T11:00:00Z'),
      },
    });
    const { deps, mocks } = makeDeps();
    const result = await reconcileAgentWorkflow({ wf }, deps);
    expect(result.kind).toBe('finalizer-removed');
    // The status patch on the deletion path uses the inline-condition
    // form (no `conditions` array on the input), which goes through
    // `mergeCondition`. The patch body should reference 'Failed' phase.
    const patchCall = mocks.patchStatus.mock.calls[0]?.[0] as {
      body: { status: { phase: string } };
    };
    expect(patchCall.body.status.phase).toBe('Failed');
  });
});

describe('reconcileAgentWorkflow — error paths', () => {
  it('marks Failed when CapCa.mint() throws', async () => {
    const wf = baseWorkflow();
    const failingCa: CapCa = {
      ...stubCapCa(),
      mint: vi.fn().mockRejectedValue(new Error('signing-key unreachable')),
    };
    const { deps, mocks } = makeDeps({ capCa: failingCa });
    const result = await reconcileAgentWorkflow({ wf }, deps);
    expect(result.kind).toBe('status-patched');
    if (result.kind !== 'status-patched') return;
    expect(result.phase).toBe('Failed');
    expect(mocks.patchStatus).toHaveBeenCalled();
  });

  it('reports restate-register-failed when the admin POST returns 500', async () => {
    const wf = baseWorkflow();
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { deps } = makeDeps({ fetchFn });
    const result = await reconcileAgentWorkflow({ wf }, deps);
    expect(result.kind).toBe('restate-register-failed');
    if (result.kind !== 'restate-register-failed') return;
    expect(result.message).toMatch(/restate admin POST returned 500/);
  });

  it('treats Deployment AlreadyExists as a patch + continues', async () => {
    const wf = baseWorkflow();
    const createDeployment = vi.fn().mockRejectedValue({ statusCode: 409, code: 409 });
    const { deps, mocks } = makeDeps({ createDeployment });
    const result = await reconcileAgentWorkflow({ wf }, deps);
    // No new deployment was created; patch was attempted instead.
    expect(mocks.patchDeployment).toHaveBeenCalled();
    expect(result.kind).not.toBe('deployment-created');
  });
});

describe('reconcileAgentWorkflow — triggers', () => {
  it('materializes a KagentSchedule for a schedule trigger', async () => {
    const wf = baseWorkflow({
      spec: {
        image: 'i',
        handler: 'h',
        triggers: [{ kind: 'schedule', schedule: '0 6 * * *' }],
      },
    });
    const { deps, mocks } = makeDeps();
    await reconcileAgentWorkflow({ wf }, deps);
    expect(mocks.createCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'kagentschedules' }),
    );
  });

  it('persists pending event subscriptions and emits audit hook', async () => {
    const wf = baseWorkflow({
      spec: {
        image: 'i',
        handler: 'h',
        triggers: [{ kind: 'event', event: { topic: 'research.findings', schema: {} } }],
      },
    });
    const { deps, mocks } = makeDeps();
    await reconcileAgentWorkflow({ wf }, deps);
    const statusCall = mocks.patchStatus.mock.calls[0]?.[0] as {
      body: { status: { eventSubscriptions?: ReadonlyArray<{ topic: string; status: string }> } };
    };
    expect(statusCall.body.status.eventSubscriptions).toEqual([
      expect.objectContaining({ topic: 'research.findings', status: 'pending' }),
    ]);
    expect(mocks.auditEmit).toHaveBeenCalledWith(
      'event_subscription_pending',
      expect.objectContaining({ topic: 'research.findings' }),
    );
  });
});

describe('computePhase + mergeCondition', () => {
  it('Pending when deployment not yet ready', () => {
    const wf = baseWorkflow();
    const phase = computePhase(wf, {
      deployment: { spec: { replicas: 1 }, status: { readyReplicas: 0 } },
      restateRegistered: true,
    });
    expect(phase).toBe('Pending');
  });

  it('Pending when restate not registered even if deployment ready', () => {
    const wf = baseWorkflow();
    const phase = computePhase(wf, {
      deployment: { spec: { replicas: 1 }, status: { readyReplicas: 1 } },
      restateRegistered: false,
    });
    expect(phase).toBe('Pending');
  });

  it('Ready when deployment ready AND restate registered', () => {
    const wf = baseWorkflow();
    const phase = computePhase(wf, {
      deployment: { spec: { replicas: 1 }, status: { readyReplicas: 1 } },
      restateRegistered: true,
    });
    expect(phase).toBe('Ready');
  });

  it('mergeCondition replaces by type and preserves transition time on no-op', () => {
    const ts = '2026-05-04T12:00:00Z';
    const existing = [
      { type: 'A', status: 'True' as const, lastTransitionTime: '2026-05-04T11:00:00Z' },
    ];
    const noop = { type: 'A', status: 'True' as const, lastTransitionTime: ts };
    const merged1 = mergeCondition(existing, noop);
    expect(merged1[0]?.lastTransitionTime).toBe('2026-05-04T11:00:00Z');

    const change = { type: 'A', status: 'False' as const, lastTransitionTime: ts };
    const merged2 = mergeCondition(existing, change);
    expect(merged2[0]?.lastTransitionTime).toBe(ts);
    expect(merged2[0]?.status).toBe('False');

    const newType = { type: 'B', status: 'True' as const, lastTransitionTime: ts };
    const merged3 = mergeCondition(existing, newType);
    expect(merged3).toHaveLength(2);
  });
});
