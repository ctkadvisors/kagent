/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { describe, expect, it, vi } from 'vitest';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import { API_GROUP_VERSION, type AgentTask } from './crds/index.js';
import type {
  Channel,
  ChannelBinding,
  ChannelInboundEnvelope,
  ChannelSession,
} from './crds/index.js';
import {
  buildKubernetesChannelControllerStore,
  reconcileChannelInbound,
  type ChannelControllerStore,
} from './channel-controller.js';

const namespace = 'kagent-system';
const now = '2026-06-12T16:45:00.000Z';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Channel',
    metadata: { name: 'wa-main', namespace, generation: 7 },
    spec: {
      provider: 'whatsapp',
      accountId: 'acct-main',
      policy: { dmPolicy: 'allowlist', allowFrom: ['user-1'] },
    },
    ...overrides,
  };
}

function makeBinding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelBinding',
    metadata: { name: 'wa-user-agent', namespace },
    spec: {
      channelRef: { name: 'wa-main' },
      match: { accountId: 'acct-main' },
      target: {
        agentRef: { name: 'useful-agent' },
        profileRef: 'local-safe',
        toolProfileRef: 'browser-code',
        runConfig: { timeoutSeconds: 90, maxIterations: 3, costLimitUsd: 0 },
      },
    },
    ...overrides,
  };
}

function makeInbound(overrides: Partial<ChannelInboundEnvelope> = {}): ChannelInboundEnvelope {
  return {
    channelName: 'wa-main',
    provider: 'whatsapp',
    accountId: 'acct-main',
    peer: { kind: 'dm', id: 'user-1' },
    sender: { id: 'user-1', displayName: 'User One' },
    messageId: 'wamid.abc',
    text: 'Check the cluster and tell me what is unhealthy.',
    ...overrides,
  };
}

function makeStore(overrides: Partial<ChannelControllerStore> = {}): ChannelControllerStore {
  return {
    getChannel: vi.fn().mockResolvedValue(makeChannel()),
    listChannelBindings: vi.fn().mockResolvedValue([makeBinding()]),
    getChannelSession: vi.fn().mockResolvedValue(undefined),
    createChannelSession: vi.fn((session: ChannelSession) =>
      Promise.resolve({ session, created: true }),
    ),
    patchChannelStatus: vi.fn().mockResolvedValue(undefined),
    patchChannelSessionStatus: vi.fn().mockResolvedValue(undefined),
    createAgentTask: vi.fn((task: AgentTask) => Promise.resolve({ task, created: true })),
    ...overrides,
  };
}

describe('reconcileChannelInbound', () => {
  it('creates a ChannelSession before creating a bounded AgentTask for an allowed inbound turn', async () => {
    const calls: string[] = [];
    const store = makeStore({
      createChannelSession: vi.fn((session: ChannelSession) => {
        calls.push(`session:${session.metadata.name ?? ''}`);
        return Promise.resolve({ session, created: true });
      }),
      createAgentTask: vi.fn((task: AgentTask) => {
        calls.push(`task:${task.metadata.name ?? ''}`);
        return Promise.resolve({
          task: { ...task, metadata: { ...task.metadata, uid: 'task-uid-1' } },
          created: true,
        });
      }),
    });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound(),
      store,
      clock: () => new Date(now),
    });

    expect(result.action).toBe('created');
    if (result.action !== 'created') throw new Error(`unexpected action ${result.action}`);
    expect(calls[0]).toMatch(/^session:kcs-wa-main-/);
    expect(calls[1]).toMatch(/^task:kct-wa-main-/);
    expect(result.session.spec).toMatchObject({
      channelRef: { name: 'wa-main' },
      provider: 'whatsapp',
      accountId: 'acct-main',
      peer: { kind: 'dm', id: 'user-1' },
      bindingRef: { name: 'wa-user-agent' },
      target: { agentRef: { name: 'useful-agent' } },
    });
    expect(result.task.spec).toMatchObject({
      targetAgent: 'useful-agent',
      runConfig: { timeoutSeconds: 90, maxIterations: 3, costLimitUsd: 0 },
      payload: {
        channel: 'wa-main',
        provider: 'whatsapp',
        accountId: 'acct-main',
        messageId: 'wamid.abc',
        text: 'Check the cluster and tell me what is unhealthy.',
        profileRef: 'local-safe',
      },
    });
    expect(store.patchChannelSessionStatus).toHaveBeenCalledWith(
      namespace,
      result.session.metadata.name,
      expect.objectContaining({
        phase: 'Active',
        observedGeneration: 1,
        lastInboundAt: now,
        lastTaskRef: { namespace, name: result.task.metadata.name, uid: 'task-uid-1' },
      }),
    );
  });

  it('denies before route lookup when channel policy rejects the sender', async () => {
    const store = makeStore();

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound({ peer: { kind: 'dm', id: 'intruder' }, sender: { id: 'intruder' } }),
      store,
      clock: () => new Date(now),
    });

    expect(result).toEqual({ action: 'denied', reason: 'dm_sender_not_allowed' });
    expect(store.listChannelBindings).not.toHaveBeenCalled();
    expect(store.createAgentTask).not.toHaveBeenCalled();
  });

  it('records denied inbound metadata on the Channel without storing message text', async () => {
    const patchChannelStatus = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({
      patchChannelStatus,
    });
    const inbound = makeInbound({
      peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
      sender: { id: '15551234567@s.whatsapp.net', displayName: 'Operator Phone' },
      messageId: 'wamid.denied',
      text: 'This text must not be written to Channel status.',
    });

    const result = await reconcileChannelInbound({
      namespace,
      inbound,
      store,
      clock: () => new Date(now),
    });

    expect(result).toEqual({ action: 'denied', reason: 'dm_sender_not_allowed' });
    expect(patchChannelStatus).toHaveBeenCalledWith(
      namespace,
      'wa-main',
      expect.objectContaining({
        lastDeniedInbound: {
          at: now,
          reason: 'dm_sender_not_allowed',
          peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
          sender: { id: '15551234567@s.whatsapp.net', displayName: 'Operator Phone' },
          messageId: 'wamid.denied',
        },
      }),
    );
    expect(JSON.stringify(patchChannelStatus.mock.calls)).not.toContain('This text must not');
  });

  it('keeps denial semantics when last-denied status observation fails', async () => {
    const store = makeStore({
      patchChannelStatus: vi.fn().mockRejectedValue(new Error('status unavailable')),
    });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound({ peer: { kind: 'dm', id: 'intruder' }, sender: { id: 'intruder' } }),
      store,
      clock: () => new Date(now),
    });

    expect(result).toEqual({ action: 'denied', reason: 'dm_sender_not_allowed' });
    expect(store.listChannelBindings).not.toHaveBeenCalled();
    expect(store.createAgentTask).not.toHaveBeenCalled();
  });

  it('returns no_route when no active binding matches the channel turn', async () => {
    const store = makeStore({ listChannelBindings: vi.fn().mockResolvedValue([]) });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound(),
      store,
      clock: () => new Date(now),
    });

    expect(result).toEqual({ action: 'denied', reason: 'no_route' });
    expect(store.createChannelSession).not.toHaveBeenCalled();
    expect(store.createAgentTask).not.toHaveBeenCalled();
  });

  it('holds approved bindings without creating an AgentTask', async () => {
    const store = makeStore({
      listChannelBindings: vi.fn().mockResolvedValue([
        makeBinding({
          spec: {
            ...makeBinding().spec,
            approval: { required: true, mode: 'per-turn' },
          },
        }),
      ]),
    });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound(),
      store,
      clock: () => new Date(now),
    });

    expect(result).toEqual({
      action: 'approval_required',
      bindingName: 'wa-user-agent',
      mode: 'per-turn',
    });
    expect(store.createChannelSession).not.toHaveBeenCalled();
    expect(store.createAgentTask).not.toHaveBeenCalled();
  });

  it('does not create more work when the existing session is in backoff', async () => {
    const backoffUntil = '2026-06-12T16:50:00.000Z';
    const existing: ChannelSession = {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelSession',
      metadata: { name: 'kcs-wa-main-existing', namespace },
      spec: {
        channelRef: { name: 'wa-main' },
        provider: 'whatsapp',
        accountId: 'acct-main',
        peer: { kind: 'dm', id: 'user-1' },
        sessionKey: 'agent:useful-agent:channel:wa-main:account:acct-main:dm:user-1',
        bindingRef: { name: 'wa-user-agent' },
        target: makeBinding().spec.target,
      },
      status: { phase: 'Backoff', backoffUntil },
    };
    const store = makeStore({ getChannelSession: vi.fn().mockResolvedValue(existing) });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound(),
      store,
      clock: () => new Date(now),
    });

    expect(result).toMatchObject({
      action: 'denied',
      reason: 'session_backoff',
      backoffUntil,
    });
    if (result.action !== 'denied') throw new Error(`unexpected action ${result.action}`);
    expect(result.sessionName).toMatch(/^kcs-wa-main-/);
    expect(store.createAgentTask).not.toHaveBeenCalled();
  });

  it('treats duplicate AgentTask creation as an idempotent duplicate inbound turn', async () => {
    const store = makeStore({
      createAgentTask: vi.fn((task: AgentTask) => Promise.resolve({ task, created: false })),
    });

    const result = await reconcileChannelInbound({
      namespace,
      inbound: makeInbound(),
      store,
      clock: () => new Date(now),
    });

    expect(result.action).toBe('duplicate');
    if (result.action !== 'duplicate') throw new Error(`unexpected action ${result.action}`);
    expect(result.task.metadata.name).toMatch(/^kct-wa-main-/);
    expect(store.patchChannelSessionStatus).not.toHaveBeenCalled();
  });
});

describe('buildKubernetesChannelControllerStore', () => {
  it('lists only ChannelBindings for the requested channel', async () => {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeBinding(),
          makeBinding({
            metadata: { name: 'other', namespace },
            spec: { ...makeBinding().spec, channelRef: { name: 'other-channel' } },
          }),
          {
            apiVersion: API_GROUP_VERSION,
            kind: 'ChannelBinding',
            metadata: { name: 'malformed' },
            spec: {},
          },
        ],
      }),
    } as unknown as CustomObjectsApi;
    const store = buildKubernetesChannelControllerStore(customApi);

    const bindings = await store.listChannelBindings(namespace, 'wa-main');

    expect(bindings.map((b) => b.metadata.name)).toEqual(['wa-user-agent']);
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace,
      plural: 'channelbindings',
    });
  });

  it('treats 404 Channel lookup as missing', async () => {
    const err = new Error('not found') as Error & { code?: number };
    err.code = 404;
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue(err),
    } as unknown as CustomObjectsApi;
    const store = buildKubernetesChannelControllerStore(customApi);

    await expect(store.getChannel(namespace, 'missing')).resolves.toBeUndefined();
  });

  it('treats 409 create conflicts as idempotent existing ChannelSessions', async () => {
    const conflict = new Error('exists') as Error & { code?: number };
    conflict.code = 409;
    const existing: ChannelSession = {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelSession',
      metadata: { name: 'kcs-wa-main-abc', namespace, uid: 'session-uid' },
      spec: {
        channelRef: { name: 'wa-main' },
        provider: 'whatsapp',
        accountId: 'acct-main',
        peer: { kind: 'dm', id: 'user-1' },
        sessionKey: 'session-key',
        target: makeBinding().spec.target,
      },
    };
    const customApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValue(conflict),
      getNamespacedCustomObject: vi.fn().mockResolvedValue(existing),
    } as unknown as CustomObjectsApi;
    const store = buildKubernetesChannelControllerStore(customApi);

    const desired: ChannelSession = {
      ...existing,
      metadata: { name: existing.metadata.name, namespace: existing.metadata.namespace },
    };

    const result = await store.createChannelSession(desired);

    expect(result).toEqual({ session: existing, created: false });
    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace,
      plural: 'channelsessions',
      name: 'kcs-wa-main-abc',
    });
  });

  it('patches ChannelSession status with merge-patch content type', async () => {
    const customApi = {
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    } as unknown as CustomObjectsApi;
    const store = buildKubernetesChannelControllerStore(customApi);

    await store.patchChannelSessionStatus(namespace, 'kcs-wa-main-abc', { phase: 'Active' });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace,
        plural: 'channelsessions',
        name: 'kcs-wa-main-abc',
        body: { status: { phase: 'Active' } },
      },
      expect.any(Object),
    );
  });

  it('patches Channel status with merge-patch content type', async () => {
    const customApi = {
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    } as unknown as CustomObjectsApi;
    const store = buildKubernetesChannelControllerStore(customApi);

    await store.patchChannelStatus(namespace, 'wa-main', {
      lastDeniedInbound: {
        at: now,
        reason: 'dm_sender_not_allowed',
        peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
        messageId: 'wamid.denied',
      },
    });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace,
        plural: 'channels',
        name: 'wa-main',
        body: {
          status: {
            lastDeniedInbound: {
              at: now,
              reason: 'dm_sender_not_allowed',
              peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
              messageId: 'wamid.denied',
            },
          },
        },
      },
      expect.any(Object),
    );
  });
});
