/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

// vitest's `vi.fn()` returns `Mock<any, any>` by default; .mockResolvedValue
// then propagates `any` through the test surface. Typing every fn() call
// against the K8s API shapes is more churn than payoff for a reconcile test
// — the intent is mock-call assertions, not type-level coverage.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { decodeCapabilityJwtUnsafe } from '@kagent/capability-types';

import { API_GROUP_VERSION, type Agent, type AgentTask, type Tenant } from './crds/index.js';
import { loadFromMaterials } from './cap-ca.js';
import { StubDispatcher } from './dispatcher.js';
import {
  markAgentTaskFailedFromExternal,
  reconcileAgentTask,
  reconcileParentFromChildEvent,
  type ReconcileDeps,
} from './reconcile.js';
import { PARENT_TASK_NAME_LABEL, PARENT_TASK_UID_LABEL } from './task-graph.js';

/* =====================================================================
 * Mock factories — stand in for @kubernetes/client-node clients.
 * ===================================================================== */

interface MockCustomApi {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
}
interface MockBatchApi {
  createNamespacedJob: ReturnType<typeof vi.fn>;
  readNamespacedJob: ReturnType<typeof vi.fn>;
  patchNamespacedJob: ReturnType<typeof vi.fn>;
}
interface MockCoreApi {
  createNamespacedConfigMap: ReturnType<typeof vi.fn>;
  createNamespacedSecret: ReturnType<typeof vi.fn>;
  readNamespacedSecret: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: {
  customApi?: Partial<MockCustomApi>;
  batchApi?: Partial<MockBatchApi>;
  coreApi?: Partial<MockCoreApi>;
  dispatcher?: StubDispatcher;
  capabilityRegistry?: ReconcileDeps['capabilityRegistry'];
  capCa?: ReconcileDeps['capCa'];
  capJwksUrl?: string;
  capTtlPolicy?: ReconcileDeps['capTtlPolicy'];
  resolveTenantForTask?: ReconcileDeps['resolveTenantForTask'];
  emitCapabilityMinted?: ReconcileDeps['emitCapabilityMinted'];
  emitKeyrotationCapMintedWithTtl?: ReconcileDeps['emitKeyrotationCapMintedWithTtl'];
  now?: () => Date;
  admissionControlEnabled?: boolean;
}): ReconcileDeps & {
  mocks: {
    customApi: MockCustomApi;
    batchApi: MockBatchApi;
    coreApi?: MockCoreApi;
    dispatcher: StubDispatcher;
  };
} {
  const customApi: MockCustomApi = {
    getNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    ...overrides.customApi,
  };
  // WS-F default: Job exists post-create, no `dispatch-published`
  // annotation yet → publish path runs. Tests that exercise the
  // re-reconcile path override readNamespacedJob to return a Job
  // carrying the annotation.
  const batchApi: MockBatchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
    readNamespacedJob: vi.fn().mockResolvedValue({
      metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
      spec: { suspend: true },
    }),
    patchNamespacedJob: vi.fn().mockResolvedValue({}),
    ...overrides.batchApi,
  };
  const coreApi =
    overrides.coreApi !== undefined
      ? ({
          createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
          createNamespacedSecret: vi.fn().mockResolvedValue({}),
          readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
          ...overrides.coreApi,
        } satisfies MockCoreApi)
      : undefined;
  const dispatcher = overrides.dispatcher ?? new StubDispatcher();
  return {
    customApi: customApi as unknown as ReconcileDeps['customApi'],
    batchApi: batchApi as unknown as ReconcileDeps['batchApi'],
    ...(coreApi !== undefined && { coreApi: coreApi as unknown as ReconcileDeps['coreApi'] }),
    dispatcher,
    ...(overrides.capabilityRegistry !== undefined && {
      capabilityRegistry: overrides.capabilityRegistry,
    }),
    ...(overrides.now !== undefined && { now: overrides.now }),
    ...(overrides.admissionControlEnabled !== undefined && {
      admissionControlEnabled: overrides.admissionControlEnabled,
    }),
    ...(overrides.capCa !== undefined && { capCa: overrides.capCa }),
    ...(overrides.capJwksUrl !== undefined && { capJwksUrl: overrides.capJwksUrl }),
    ...(overrides.capTtlPolicy !== undefined && { capTtlPolicy: overrides.capTtlPolicy }),
    ...(overrides.resolveTenantForTask !== undefined && {
      resolveTenantForTask: overrides.resolveTenantForTask,
    }),
    ...(overrides.emitCapabilityMinted !== undefined && {
      emitCapabilityMinted: overrides.emitCapabilityMinted,
    }),
    ...(overrides.emitKeyrotationCapMintedWithTtl !== undefined && {
      emitKeyrotationCapMintedWithTtl: overrides.emitKeyrotationCapMintedWithTtl,
    }),
    mocks: { customApi, batchApi, ...(coreApi !== undefined && { coreApi }), dispatcher },
  };
}

/* =====================================================================
 * Fixtures
 * ===================================================================== */

const validAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
};

async function makeCa() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  return await loadFromMaterials({ privatePem, publicPem, kid: 'test-kid' });
}

function makeTenant(overrides: Partial<Tenant['spec']> = {}): Tenant {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: { name: overrides.name ?? 'acme', uid: 'tenant-uid-acme' },
    spec: {
      name: 'acme',
      namespaceAllowlist: ['default'],
      ...overrides,
    },
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'k3s' },
      originalUserMessage: 'what is k3s default runtime?',
    },
    ...overrides,
  };
}

/* =====================================================================
 * Tests
 * ===================================================================== */

describe('reconcileAgentTask — skip paths', () => {
  it.each(['Completed', 'Failed', 'Dispatched'] as const)('skips when phase=%s', async (phase) => {
    const task = makeTask({ status: { phase } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(task, deps);
    expect(result).toEqual({ action: 'skipped', reason: `phase=${phase}` });
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(deps.mocks.dispatcher.published).toHaveLength(0);
  });

  it('does NOT skip when phase is undefined (treated as Pending)', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });
});

describe('reconcileAgentTask — happy path (targetAgent)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let task: AgentTask;
  const fixedNow = new Date('2026-04-26T10:00:00.000Z');

  beforeEach(() => {
    task = makeTask();
    deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
    });
  });

  it('returns action=dispatched with the deterministic Job name', async () => {
    const result = await reconcileAgentTask(task, deps);
    expect(result).toEqual({ action: 'dispatched', jobName: 'kat-task-uid-1' });
  });

  it('fetches the target Agent in the same namespace as the task', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'default',
        plural: 'agents',
        name: 'researcher',
      }),
    );
  });

  it('creates a Job in the AgentTask namespace', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        body: expect.objectContaining({
          kind: 'Job',
          metadata: expect.objectContaining({ name: 'kat-task-uid-1' }),
        }),
      }),
    );
  });

  it('creates the Job in suspended state (WS-F)', async () => {
    await reconcileAgentTask(task, deps);
    const callBody = deps.mocks.batchApi.createNamespacedJob.mock.calls[0]?.[0]?.body as {
      spec?: { suspend?: boolean };
    };
    expect(callBody?.spec?.suspend).toBe(true);
  });

  it('passes a dedupeId equal to the task UID on publish', async () => {
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const localDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      dispatcher,
    });
    await reconcileAgentTask(task, localDeps);
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-uid-1' }), {
      dedupeId: 'task-uid-1',
    });
  });

  it('annotates the Job with dispatch-published="true" after publish', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.batchApi.patchNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        name: 'kat-task-uid-1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: expect.objectContaining({
              'kagent.knuteson.io/dispatch-published': 'true',
            }),
          }),
        }),
      }),
      // job-annotator now passes a Content-Type override as the 2nd arg
      // (application/merge-patch+json) — see job-annotator.ts:MERGE_PATCH_OPTIONS.
      expect.anything() as unknown,
    );
  });

  it('unsuspends the Job (spec.suspend=false) after publish + annotation', async () => {
    await reconcileAgentTask(task, deps);
    const calls = deps.mocks.batchApi.patchNamespacedJob.mock.calls;
    const unsuspendCall = calls.find((c: unknown[]) => {
      const arg = c[0] as { body?: { spec?: { suspend?: boolean } } };
      return arg?.body?.spec?.suspend === false;
    });
    expect(unsuspendCall).toBeDefined();
  });

  it('orders annotation BEFORE unsuspend (so a crash mid-flight strands a suspended-but-published Job, not a running-but-unmarked one)', async () => {
    const callOrder: string[] = [];
    const customDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: unknown };
          if (body.metadata !== undefined) callOrder.push('annotate');
          if (body.spec !== undefined) callOrder.push('unsuspend');
          return Promise.resolve({});
        }),
      },
      now: () => fixedNow,
    });
    await reconcileAgentTask(task, customDeps);
    expect(callOrder).toEqual(['annotate', 'unsuspend']);
  });

  it('mints a per-task capability Secret and mounts it into the Job when capCa is wired', async () => {
    const ca = await makeCa();
    const capAgent: Agent = {
      ...validAgent,
      spec: {
        ...validAgent.spec,
        capabilityClaims: {
          tools: ['http_get'],
          spawn: ['summarizer'],
          publish: ['research.findings'],
        },
      },
    };
    const localDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(capAgent),
      },
      coreApi: {},
      capCa: ca,
      capJwksUrl: 'http://operator-templates.default.svc.cluster.local:8081/.well-known/jwks.json',
    });

    await reconcileAgentTask(task, localDeps);

    expect(localDeps.mocks.coreApi?.createNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'kagent-cap-task-uid-1',
            ownerReferences: expect.arrayContaining([
              expect.objectContaining({ kind: 'AgentTask', name: 't1', uid: 'task-uid-1' }),
            ]),
          }),
          stringData: expect.objectContaining({
            'cap.jwt': expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
          }),
        }),
      }),
    );

    expect(localDeps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            capabilityRef: expect.stringMatching(/^cap-task-uid-/),
          },
        },
      }),
      expect.anything() as unknown,
    );

    const createdJob = localDeps.mocks.batchApi.createNamespacedJob.mock.calls[0]?.[0]?.body as {
      spec?: {
        template?: {
          spec?: {
            volumes?: unknown[];
            containers?: Array<{
              env?: Array<{ name: string; value?: string }>;
              volumeMounts?: unknown[];
            }>;
          };
        };
      };
    };
    const podSpec = createdJob.spec?.template?.spec;
    const container = podSpec?.containers?.[0];
    const env = new Map((container?.env ?? []).map((entry) => [entry.name, entry.value]));
    expect(env.get('KAGENT_CAP_JWT_FILE')).toBe('/var/kagent/cap/cap.jwt');
    expect(env.get('KAGENT_CAP_JWKS_URL')).toBe(
      'http://operator-templates.default.svc.cluster.local:8081/.well-known/jwks.json',
    );
    expect(env.get('KAGENT_CAP_ISSUER')).toBe('kagent.knuteson.io/operator');
    expect(podSpec?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'cap-jwt',
          secret: expect.objectContaining({ secretName: 'kagent-cap-task-uid-1' }),
        }),
      ]),
    );
    expect(container?.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'cap-jwt',
          mountPath: '/var/kagent/cap',
          readOnly: true,
        }),
      ]),
    );
  });

  it('threads Tenant CR and keyrotation TTL policy through capability minting and audit', async () => {
    const ca = await makeCa();
    const tenant = makeTenant({
      capabilityRoot: { issuer: 'kagent.knuteson.io/operator/acme' },
    });
    const capAgent: Agent = {
      ...validAgent,
      spec: {
        ...validAgent.spec,
        capabilityClaims: {
          tools: ['http_get'],
          models: ['workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'],
          spawn: ['summarizer'],
        },
      },
    };
    const longTask = makeTask({
      spec: {
        ...task.spec,
        runConfig: { timeoutSeconds: 7_200 },
      },
    });
    const resolveTenantForTask = vi.fn().mockReturnValue(tenant);
    const emitCapabilityMinted = vi.fn().mockResolvedValue(undefined);
    const emitKeyrotationCapMintedWithTtl = vi.fn().mockResolvedValue(undefined);
    const localDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(capAgent),
      },
      coreApi: {},
      capCa: ca,
      capTtlPolicy: {
        shortTtlSeconds: 3_600,
        longTtlGraceSeconds: 120,
        maxTtlSeconds: 86_400,
        longRunningThresholdSeconds: 3_600,
      },
      resolveTenantForTask,
      emitCapabilityMinted,
      emitKeyrotationCapMintedWithTtl,
    });

    await reconcileAgentTask(longTask, localDeps);

    expect(resolveTenantForTask).toHaveBeenCalledWith(longTask, capAgent);
    const secretBody = localDeps.mocks.coreApi?.createNamespacedSecret.mock.calls[0]?.[0]?.body as {
      stringData?: Record<string, string>;
    };
    const jwt = secretBody.stringData?.['cap.jwt'];
    expect(jwt).toEqual(expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/));
    const decoded = decodeCapabilityJwtUnsafe(jwt ?? '');
    expect(decoded?.iss).toBe('kagent.knuteson.io/operator/acme');
    expect(decoded?.claims.tenant).toBe('acme');
    expect(decoded?.claims.tools).toEqual(['http_get']);
    expect(decoded?.exp - (decoded?.iat ?? 0)).toBe(7_320);

    const createdJob = localDeps.mocks.batchApi.createNamespacedJob.mock.calls[0]?.[0]?.body as {
      spec?: {
        template?: {
          spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> };
        };
      };
    };
    const env = new Map(
      (createdJob.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => [
        entry.name,
        entry.value,
      ]),
    );
    expect(env.get('KAGENT_CAP_ISSUER')).toBe('kagent.knuteson.io/operator/acme');
    expect(emitCapabilityMinted).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: 'kagent.knuteson.io/operator/acme',
        claims: expect.objectContaining({
          tenant: 'acme',
          tools: ['http_get'],
          spawn: ['summarizer'],
        }),
      }),
    );
    expect(emitKeyrotationCapMintedWithTtl).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSeconds: 7_320,
        tier: 'long-running-grace',
      }),
    );
  });

  it('publishes a DispatchedTask envelope with the originalUserMessage + payload', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.dispatcher.published).toHaveLength(1);
    expect(deps.mocks.dispatcher.published[0]).toMatchObject({
      taskId: 'task-uid-1',
      agentId: 'researcher',
      originalUserMessage: 'what is k3s default runtime?',
      payload: { topic: 'k3s' },
    });
  });

  it('threads parentTask + parentDistillation + expectedTools into the envelope', async () => {
    const delegated = makeTask({
      spec: {
        ...task.spec,
        parentTask: 'parent-uid',
        parentDistillation: 'distilled prompt',
        expectedTools: ['fetch_url'],
      },
    });
    await reconcileAgentTask(delegated, deps);
    expect(deps.mocks.dispatcher.published[0]).toMatchObject({
      parentTaskId: 'parent-uid',
      parentDistillation: 'distilled prompt',
      expectedTools: ['fetch_url'],
    });
  });

  it('patches AgentTask.status with phase=Dispatched + podName + startedAt + observedGeneration + condition', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        name: 't1',
        body: {
          status: expect.objectContaining({
            phase: 'Dispatched',
            podName: 'kat-task-uid-1',
            startedAt: fixedNow.toISOString(),
            observedGeneration: 0,
            conditions: expect.arrayContaining([
              expect.objectContaining({
                type: 'Dispatched',
                status: 'True',
                reason: 'JobCreated',
                lastTransitionTime: fixedNow.toISOString(),
              }),
            ]),
          }),
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });
});

describe('reconcileAgentTask — admission control (LLM-gateway bundle)', () => {
  // When `admissionControlEnabled: true`, reconcile publishes the
  // dispatch envelope + creates the suspended Job + annotates it,
  // but DOES NOT un-suspend the Job and DOES NOT patch status to
  // Dispatched. The admission reconciler (`admission.ts`) owns those
  // transitions, gated by ModelEndpoint capacity + Agent
  // maxInFlightTasks. This preserves the WS-F suspended-publish
  // ordering while letting capacity gating land independently.
  let task: AgentTask;
  const fixedNow = new Date('2026-04-26T10:00:00.000Z');

  beforeEach(() => {
    task = makeTask();
  });

  it('does NOT un-suspend the Job when admissionControlEnabled=true', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
      admissionControlEnabled: true,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('admission-pending');
    expect(result.jobName).toBe('kat-task-uid-1');
    // Annotation patch happens (publish-then-annotate); un-suspend
    // patch (spec.suspend=false) does NOT.
    const patchCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls;
    const unsuspendCall = patchCalls.find((c: unknown[]) => {
      const arg = c[0] as { body?: { spec?: { suspend?: boolean } } };
      return arg?.body?.spec?.suspend === false;
    });
    expect(unsuspendCall).toBeUndefined();
  });

  it('does NOT patch status to Dispatched when admissionControlEnabled=true', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
      admissionControlEnabled: true,
    });
    await reconcileAgentTask(task, deps);
    // Status patch is the LAST step of the dispatch path; it gates on
    // the un-suspend success. Skipping un-suspend means status stays
    // Pending — the admission reconciler will mark Dispatched when it
    // un-suspends.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('still publishes the dispatch envelope to the bus', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      admissionControlEnabled: true,
    });
    await reconcileAgentTask(task, deps);
    // The bus message is what tells the agent-pod its task assignment;
    // we still publish so the moment admission un-suspends the Job, the
    // pod has everything it needs.
    expect(deps.mocks.dispatcher.published).toHaveLength(1);
    expect(deps.mocks.dispatcher.published[0]).toMatchObject({
      taskId: 'task-uid-1',
      agentId: 'researcher',
    });
  });

  it('still annotates the Job with dispatch-published="true"', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      admissionControlEnabled: true,
    });
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.batchApi.patchNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: expect.objectContaining({
              'kagent.knuteson.io/dispatch-published': 'true',
            }),
          }),
        }),
      }),
      expect.anything() as unknown,
    );
  });

  it('un-suspends + dispatches as today when admissionControlEnabled is false (default)', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
    });
    // admissionControlEnabled left undefined → falsy → today's path.
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    // Un-suspend patch happens.
    const patchCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls;
    const unsuspendCall = patchCalls.find((c: unknown[]) => {
      const arg = c[0] as { body?: { spec?: { suspend?: boolean } } };
      return arg?.body?.spec?.suspend === false;
    });
    expect(unsuspendCall).toBeDefined();
    // Status patch to Dispatched happens.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
  });

  it('admissionControlEnabled=false explicit value behaves identically to undefined', async () => {
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
      admissionControlEnabled: false,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });
});

describe('reconcileAgentTask — capability resolution', () => {
  it('dispatches when registry resolves capability → agent', async () => {
    const { StaticCapabilityRegistry } = await import('./capability-registry.js');
    const task = makeTask({
      spec: {
        targetCapability: 'research',
        payload: {},
        originalUserMessage: 'do the thing',
      },
    });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      capabilityRegistry: new StaticCapabilityRegistry({ research: 'researcher' }),
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'researcher' }),
    );
  });
});

describe('reconcileAgentTask — failure paths', () => {
  it('marks Failed when targetCapability is set but the registry returns null', async () => {
    const task = makeTask({
      spec: {
        targetCapability: 'researcher',
        payload: {},
      },
    });
    // markFailed → patchStatusWithRetry re-reads the AgentTask before
    // building the patch. Configure the mock to return the same task
    // shape on both Agent + AgentTask GETs (the build closure only
    // touches `status.phase` + `metadata.generation`, and an absent
    // status is fine).
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(task),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/no live agent satisfies capability 'researcher'/);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: expect.objectContaining({ phase: 'Failed' }) },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('marks Failed when neither targetAgent nor targetCapability is set', async () => {
    const task = makeTask({ spec: { payload: {} } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/neither targetAgent nor targetCapability/);
  });

  it('marks Failed when the resolved object has a malformed Agent shape', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue({ apiVersion: 'kagent.dev/v1', kind: 'Agent' }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/malformed shape/);
  });

  it('marks Failed when the Agent fetch rejects', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('not found')),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/not found/);
  });

  it('marks Failed when Job creation throws a non-409 error', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(new Error('forbidden')),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/job creation failed.*forbidden/);
  });

  it('treats Job creation 409 AlreadyExists as success (idempotency)', async () => {
    const task = makeTask();
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });

  it('marks Failed when Dispatcher.publish throws', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    vi.spyOn(dispatcher, 'publish').mockRejectedValueOnce(new Error('bus down'));
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/dispatch failed.*bus down/);
  });
});

/* =====================================================================
 * WS-F: suspended-publish dispatch ordering races. The reconcile flow
 * is publish-then-annotate-then-unsuspend; each scenario below pins
 * down a specific failure mode that the audit flagged.
 * ===================================================================== */

describe('reconcileAgentTask — WS-F dispatch ordering races', () => {
  /**
   * Re-reconcile after a successful publish: the Job already carries
   * the `dispatch-published: "true"` annotation. The reconcile must
   * SKIP publish (don't double-fire) and proceed straight to unsuspend.
   */
  it('skips publish when the Job already carries dispatch-published="true"', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        // Job exists and was already published — re-reconcile path.
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: {
            name: 'kat-task-uid-1',
            namespace: 'default',
            annotations: { 'kagent.knuteson.io/dispatch-published': 'true' },
          },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(publishSpy).not.toHaveBeenCalled();
    // Annotation patch is also skipped (we already have it).
    const annotationPatchCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { metadata?: unknown } })?.body;
        return body?.metadata !== undefined;
      },
    );
    expect(annotationPatchCalls).toHaveLength(0);
    // Unsuspend still runs.
    const unsuspendCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { spec?: { suspend?: boolean } } })?.body;
        return body?.spec?.suspend === false;
      },
    );
    expect(unsuspendCalls).toHaveLength(1);
  });

  /**
   * Crash between Job-create and publish: re-reconcile sees Job exists
   * (409 idempotent) and no `dispatch-published` annotation → publishes
   * with dedupeId = task.uid. Validates the dedupeId is stable across
   * reconcile retries (the broker takes care of deduping the actual
   * second publish; we just have to pin that the operator passes the
   * SAME id).
   */
  it('re-reconcile after Job-create crash → publishes with task-uid dedupeId (broker-side dedupe is the safety net)', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        // Job-create returns 409 — already exists from a prior reconcile.
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
        // No annotation yet — prior reconcile crashed before publish or
        // before annotation-patch.
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(expect.anything(), { dedupeId: 'task-uid-1' });
  });

  /**
   * Annotation-patch failure post-publish must NOT mark the AgentTask
   * Failed — the message is on the bus. Operator returns dispatched;
   * the next reconcile would re-publish (broker dedupe drops it).
   */
  it('annotation-patch failure is logged but treated as success (broker dedupe handles re-publish)', async () => {
    const task = makeTask();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: unknown };
          if (body.metadata !== undefined) {
            return Promise.reject(new Error('apiserver flaky'));
          }
          return Promise.resolve({});
        }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('FAILED to stamp dispatch-published annotation'),
      expect.anything(),
    );
    // Status was still patched to Dispatched (best-effort marker for
    // user visibility; the in-cluster source of truth is the Job
    // annotation + the bus dedupe).
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: expect.objectContaining({ phase: 'Dispatched' }) },
      }),
      expect.anything(),
    );
    consoleErr.mockRestore();
  });

  /**
   * Unsuspend failure leaves the Job suspended. AgentTask is NOT marked
   * Failed (recoverable on next reconcile) and NOT marked Dispatched
   * (the pod hasn't run). Reconcile returns 'failed' so the caller can
   * record metrics/log noise, but the status stays untouched.
   */
  it('unsuspend failure returns action=failed and leaves AgentTask status untouched (informer relist retries)', async () => {
    const task = makeTask();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: { suspend?: boolean } };
          if (body.spec?.suspend === false) {
            return Promise.reject(new Error('forbidden'));
          }
          return Promise.resolve({});
        }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/unsuspend failed/);
    // Status NOT marked Failed (we want a relist to retry, not a sticky terminal).
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('failed to unsuspend Job'),
      expect.anything(),
    );
    consoleErr.mockRestore();
  });

  /**
   * Publish failure pre-annotation: the Job is suspended and was
   * never told to run. Mark AgentTask Failed with reason "dispatch
   * failed" so the user sees a clear error.
   */
  it('publish failure marks Failed and never unsuspends the Job', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    vi.spyOn(dispatcher, 'publish').mockRejectedValueOnce(new Error('bus down'));
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/dispatch failed.*bus down/);
    // Never unsuspended — the Job stays asleep.
    const unsuspendCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { spec?: { suspend?: boolean } } })?.body;
        return body?.spec?.suspend === false;
      },
    );
    expect(unsuspendCalls).toHaveLength(0);
  });

  /**
   * StubDispatcher invariants: the same dedupeId across two reconcile
   * passes results in a single bus publish. This is the contract the
   * production NatsDispatcher inherits via JetStream's `Nats-Msg-Id`
   * header — we test it on the stub because that's where the operator's
   * unit tests live, but the broker behavior is the real safety net.
   */
  it('StubDispatcher: two reconciles with the same task UID produce ONE publish', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    // First reconcile: simulate annotation-patch failure so the second
    // reconcile takes the re-publish path.
    const deps1 = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown };
          if (body.metadata !== undefined) {
            return Promise.reject(new Error('flaky annotation-patch'));
          }
          return Promise.resolve({});
        }),
      },
      dispatcher,
    });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileAgentTask(task, deps1);
    expect(dispatcher.published).toHaveLength(1);

    // Second reconcile: Job exists, annotation still absent (because
    // patch failed). Operator passes the same dedupeId; StubDispatcher
    // drops the duplicate, mirroring JetStream's behavior.
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps2 = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    await reconcileAgentTask(task, deps2);
    // Still ONE published task — the dedupeId protected the bus.
    expect(dispatcher.published).toHaveLength(1);
    expect(dispatcher.seenDedupeIds.has('task-uid-1')).toBe(true);
    consoleErr.mockRestore();
  });
});

describe('reconcileAgentTask — namespace defaulting', () => {
  it("uses 'default' namespace when AgentTask has none set", async () => {
    const task = makeTask({
      metadata: { name: 't1', uid: 'task-uid-1' /* no namespace */ },
    });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
    });
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default' }),
    );
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default' }),
    );
  });
});

describe('markAgentTaskFailedFromExternal', () => {
  const ref = { namespace: 'kagent-system', name: 'smoke-test' };
  const failure = {
    reason: 'ImagePullBackOff',
    message: 'manifest unknown',
    source: 'pod' as const,
  };
  const fixedNow = new Date('2026-04-27T05:30:00.000Z');

  it('marks Failed when AgentTask is currently Dispatched', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Dispatched' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'marked-failed', previousPhase: 'Dispatched' });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: expect.objectContaining({
            phase: 'Failed',
            error: '[pod/ImagePullBackOff] manifest unknown',
            completedAt: fixedNow.toISOString(),
          }),
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('appends a JobFailedAfterComplete condition when AgentTask is already Completed (WS-E: never overwrite success)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Completed' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'condition-appended', previousPhase: 'Completed' });
    // The patch landed but did NOT include `phase` — terminal-monotonic.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: Record<string, unknown> };
    };
    expect(patchCall.body.status).not.toHaveProperty('phase');
    expect(patchCall.body.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'JobFailedAfterComplete',
          status: 'True',
          reason: 'ImagePullBackOff',
        }),
      ]),
    );
  });

  it('appends a fresh failure condition when AgentTask is already Failed (multi-mode failures stay observable)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Failed' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'condition-appended', previousPhase: 'Failed' });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: Record<string, unknown> };
    };
    expect(patchCall.body.status).not.toHaveProperty('phase');
    expect(patchCall.body.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ImagePullBackOff',
          status: 'True',
        }),
      ]),
    );
  });

  it('skips silently when AgentTask is gone (404 — race vs. owner GC)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'skipped', reason: 'not-found' });
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('marks Failed when status.phase is unset (early failure before reconcile)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeTask()),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'marked-failed', previousPhase: '(unset)' });
  });
});

/* =====================================================================
 * reconcileParentFromChildEvent — Workstream 5 / Phase 5 wire-up.
 *
 * Mirrors the markAgentTaskFailedFromExternal block above: every test
 * spins up a mock CustomObjectsApi configured with the parent GET
 * response and the children LIST response, calls the new entry point,
 * and asserts both the action verdict AND the patch body. The KEY
 * INVARIANT throughout: the patch body MUST NOT contain `phase` —
 * that field's ownership stays with the agent-pod and the failure
 * detector. See TASK-GRAPH.md §6.
 * ===================================================================== */

interface MockListCustomApi extends MockCustomApi {
  listNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

function makeListCustomApi(overrides: Partial<MockListCustomApi> = {}): MockListCustomApi {
  return {
    getNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    ...overrides,
  };
}

/**
 * Build a child AgentTask in the shape the operator's LIST returns:
 * carrying the parent labels and a status.phase.
 */
function makeChild(
  uid: string,
  phase: 'Pending' | 'Dispatched' | 'Completed' | 'Failed' | undefined,
  parentUid = 'parent-uid-1',
  parentName = 'parent-task',
): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: `child-${uid}`,
      namespace: 'default',
      uid,
      labels: {
        [PARENT_TASK_UID_LABEL]: parentUid,
        [PARENT_TASK_NAME_LABEL]: parentName,
      },
    },
    spec: {
      targetAgent: 'researcher',
      payload: {},
      parentTask: parentUid,
      originalUserMessage: 'plan a k3s upgrade',
    },
    ...(phase !== undefined && { status: { phase } }),
  };
}

const PARENT_REF = { namespace: 'default', name: 'parent-task' };

function makeParent(overrides: Partial<AgentTask> = {}): AgentTask {
  return makeTask({
    metadata: { name: 'parent-task', namespace: 'default', uid: 'parent-uid-1' },
    ...overrides,
  });
}

describe('reconcileParentFromChildEvent — child aggregation projection', () => {
  it('projects empty list → aggregatePhase=Pending with all counts at 0', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'Pending', childCount: 0 });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            children: [],
            aggregatePhase: 'Pending',
            successCount: 0,
            failureCount: 0,
            inFlightCount: 0,
          },
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('projects 3 Completed children → AllComplete with successCount=3', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeChild('c1', 'Completed'),
          makeChild('c2', 'Completed'),
          makeChild('c3', 'Completed'),
        ],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'AllComplete', childCount: 3 });
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: { successCount: number; failureCount: number; inFlightCount: number } };
    };
    expect(patchCall.body.status.successCount).toBe(3);
    expect(patchCall.body.status.failureCount).toBe(0);
    expect(patchCall.body.status.inFlightCount).toBe(0);
  });

  it('projects 1 Failed + 2 Completed → AnyFailed with failureCount=1, successCount=2', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeChild('c1', 'Completed'),
          makeChild('c2', 'Completed'),
          makeChild('c3', 'Failed'),
        ],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'AnyFailed', childCount: 3 });
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: { successCount: number; failureCount: number; inFlightCount: number } };
    };
    expect(patchCall.body.status.failureCount).toBe(1);
    expect(patchCall.body.status.successCount).toBe(2);
    expect(patchCall.body.status.inFlightCount).toBe(0);
  });

  it('returns skipped/not-found when the parent AgentTask is gone (404)', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'skipped', reason: 'not-found' });
    expect(customApi.listNamespacedCustomObject).not.toHaveBeenCalled();
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('still updates children/aggregatePhase when parent is already terminal (Completed) without touching status.phase', async () => {
    const completedParent = makeParent({ status: { phase: 'Completed' } });
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(completedParent),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [makeChild('c1', 'Failed')],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action.kind).toBe('updated');
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const body = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
        body: { status: Record<string, unknown> };
      }
    ).body.status;
    // CRITICAL: the patch body must NOT include `phase`. Aggregate state is
    // parallel data — terminal parents stay terminal; only their child
    // projection refreshes.
    expect(body).not.toHaveProperty('phase');
    expect(body.aggregatePhase).toBe('AnyFailed');
  });

  it('LISTs children with the right labelSelector (parent-task-uid=<uid>) in the parent namespace', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    });
    await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace: 'default',
      plural: 'agenttasks',
      labelSelector: 'kagent.knuteson.io/parent-task-uid=parent-uid-1',
    });
  });

  /* -------------------------------------------------------------------
   * WS-I — projection-shape coverage that the existing tests miss:
   * the `PartiallyComplete` aggregatePhase fires when at least one
   * child has reached `Completed` AND at least one is still in flight,
   * with no failures. Truth-table tail per `aggregateChildren` in
   * task-graph.ts.
   * ------------------------------------------------------------------- */
  it('projects 2 Completed + 1 Pending → PartiallyComplete (successCount=2, inFlightCount=1)', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeChild('c1', 'Completed'),
          makeChild('c2', 'Completed'),
          makeChild('c3', 'Pending'),
        ],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({
      kind: 'updated',
      aggregatePhase: 'PartiallyComplete',
      childCount: 3,
    });
    const body = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
        body: {
          status: { successCount: number; failureCount: number; inFlightCount: number };
        };
      }
    ).body.status;
    expect(body.successCount).toBe(2);
    expect(body.failureCount).toBe(0);
    expect(body.inFlightCount).toBe(1);
  });
});

/* =====================================================================
 * reconcileParentFromChildEvent — WS-I idempotency + cycle detection.
 *
 * `reconcileParentFromChildEvent` is fired on EVERY child phase
 * transition (and on every informer relist). For typical workloads
 * that's high-frequency. The two behaviors covered here keep the
 * etcd write rate bounded:
 *
 *   - Idempotency: when the freshly-computed projection equals the
 *     parent's existing `status.children/successCount/...`, skip the
 *     PATCH entirely. The action verdict shifts from `updated` to
 *     `unchanged` so callers can still log a tick happened.
 *
 *   - Cycle detection: if any child's parent chain loops back to the
 *     parent we're projecting, walk away — refuse to project a graph
 *     we know is corrupt, log a warning, and emit a K8s Event so the
 *     bug surfaces in `kubectl describe` / Workbench TaskDetail.
 * ===================================================================== */
describe('reconcileParentFromChildEvent — WS-I idempotency', () => {
  it('skips the patch when the projection already matches parent.status (returns kind=unchanged)', async () => {
    // Parent already carries a status whose children/aggregatePhase /
    // counts EXACTLY match the projection we're about to compute.
    const c1 = makeChild('c1', 'Completed');
    const parentWithProjection = makeParent({
      status: {
        children: [
          {
            name: c1.metadata.name ?? '',
            namespace: c1.metadata.namespace ?? '',
            uid: c1.metadata.uid,
            phase: 'Completed',
          },
        ],
        aggregatePhase: 'AllComplete',
        successCount: 1,
        failureCount: 0,
        inFlightCount: 0,
      },
    });
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(parentWithProjection),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [c1] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'unchanged', aggregatePhase: 'AllComplete', childCount: 1 });
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('STILL patches when the parent has partial projection state (e.g. counts match but children differs)', async () => {
    // Counts match on the surface (1 Completed) but `children[]` has a
    // stale UID — the projection diff has to be field-by-field, not
    // just count-by-count.
    const c1 = makeChild('c1', 'Completed');
    const parentWithStale = makeParent({
      status: {
        children: [
          {
            name: 'child-OLD',
            namespace: 'default',
            uid: 'old-uid',
            phase: 'Completed',
          },
        ],
        aggregatePhase: 'AllComplete',
        successCount: 1,
        failureCount: 0,
        inFlightCount: 0,
      },
    });
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(parentWithStale),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [c1] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action.kind).toBe('updated');
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
  });

  it('patches when projection differs only in aggregatePhase (e.g. PartiallyComplete → AllComplete)', async () => {
    const c1 = makeChild('c1', 'Completed');
    const c2 = makeChild('c2', 'Completed');
    // Stale projection said PartiallyComplete; reality is AllComplete.
    const parentWithStaleAggregate = makeParent({
      status: {
        children: [
          {
            name: c1.metadata.name ?? '',
            namespace: c1.metadata.namespace ?? '',
            uid: c1.metadata.uid,
            phase: 'Completed',
          },
          {
            name: c2.metadata.name ?? '',
            namespace: c2.metadata.namespace ?? '',
            uid: c2.metadata.uid,
            phase: 'Completed',
          },
        ],
        aggregatePhase: 'PartiallyComplete',
        successCount: 2,
        failureCount: 0,
        inFlightCount: 0,
      },
    });
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(parentWithStaleAggregate),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [c1, c2] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action.kind).toBe('updated');
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileParentFromChildEvent — WS-I cycle detection', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('skips the patch + emits an AgentTaskCycleDetected Event when a child appears in the parent chain', async () => {
    // Synthesize a cycle: parent P has spec.parentTask = C.uid (so
    // walking up from P leads back through C). Child C is labeled
    // parent-task-uid=P.uid (so from P's projection, C is a child).
    // Re-projecting P → cycleCheck(P, C, getParent) walks up from P,
    // hits C, returns { ok:false }.
    const parentWithCycle = makeParent({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        originalUserMessage: 'cycle',
        parentTask: 'cycle-child-uid',
      },
    });
    const cycleChild = makeChild('cycle-child-uid', 'Pending');
    // For getTaskByUid lookups: parent.uid=parent-uid-1, child.uid=cycle-child-uid
    const cache = new Map<string, AgentTask>([
      ['parent-uid-1', parentWithCycle],
      ['cycle-child-uid', cycleChild],
    ]);

    const emitCycleEvent = vi.fn().mockResolvedValue(undefined);
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(parentWithCycle),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [cycleChild] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      getTaskByUid: (uid: string) => cache.get(uid),
      emitCycleEvent,
    });

    expect(action).toEqual({ kind: 'skipped', reason: 'cycle-detected' });
    // CRITICAL: no patch when a cycle is detected — corrupt graph,
    // refuse to write a projection on top of it.
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    // Event surfaces in `kubectl describe agenttask parent-task`.
    expect(emitCycleEvent).toHaveBeenCalledTimes(1);
    const eventArgs = emitCycleEvent.mock.calls[0] as [
      { name: string; namespace: string; uid: string },
      readonly string[],
    ];
    expect(eventArgs[0]).toEqual({
      name: 'parent-task',
      namespace: 'default',
      uid: 'parent-uid-1',
    });
    expect(eventArgs[1]).toContain('parent-uid-1');
    expect(eventArgs[1]).toContain('cycle-child-uid');
    // Warning is logged so operator-side debugging surfaces it.
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('does NOT crash when the event-emit callback throws — cycle is still skipped (event is best-effort)', async () => {
    const parentWithCycle = makeParent({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        originalUserMessage: 'cycle',
        parentTask: 'cycle-child-uid',
      },
    });
    const cycleChild = makeChild('cycle-child-uid', 'Pending');
    const cache = new Map<string, AgentTask>([
      ['parent-uid-1', parentWithCycle],
      ['cycle-child-uid', cycleChild],
    ]);
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(parentWithCycle),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [cycleChild] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      getTaskByUid: (uid: string) => cache.get(uid),
      emitCycleEvent: vi.fn().mockRejectedValue(new Error('apiserver hiccup')),
    });
    expect(action).toEqual({ kind: 'skipped', reason: 'cycle-detected' });
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('with no getTaskByUid dep, cycle detection is fail-open (existing behavior unchanged)', async () => {
    // Without a getTaskByUid the operator cannot walk the chain — per
    // spec 7, "fail-open today" means we proceed with the patch rather
    // than blocking on incomplete data.
    const c1 = makeChild('c1', 'Completed');
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [c1] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action.kind).toBe('updated');
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileParentFromChildEvent — WS-I informer-cache list', () => {
  it('uses listChildren callback when provided INSTEAD of customApi.listNamespacedCustomObject', async () => {
    const c1 = makeChild('c1', 'Completed');
    const listChildren = vi.fn().mockReturnValue([c1]);
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      listChildren,
    });
    expect(action).toEqual({
      kind: 'updated',
      aggregatePhase: 'AllComplete',
      childCount: 1,
    });
    // Cache callback fired with parentUid + namespace.
    expect(listChildren).toHaveBeenCalledWith('parent-uid-1', 'default');
    // CRITICAL: no API list when cache is provided — keeps watch-cache
    // discipline (spec point 3).
    expect(customApi.listNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('falls back to customApi.listNamespacedCustomObject when listChildren is not provided', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    });
    await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalled();
  });
});
