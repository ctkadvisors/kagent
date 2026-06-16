/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildKubernetesChannelOutboxStore,
  buildKubernetesChannelStatusPatcher,
} from './status.js';

describe('buildKubernetesChannelStatusPatcher', () => {
  it('merge-patches Channel.status in the adapter namespace', async () => {
    const customApi = {
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const patcher = buildKubernetesChannelStatusPatcher({
      customApi: customApi as never,
      namespace: 'kagent-system',
      channelName: 'telegram-work',
    });

    await patcher.patch({
      phase: 'Ready',
      pairing: { state: 'paired' },
    });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'channels',
        name: 'telegram-work',
        body: { status: { phase: 'Ready', pairing: { state: 'paired' } } },
      },
      expect.any(Object),
    );
  });
});

describe('buildKubernetesChannelOutboxStore', () => {
  it('lists only ChannelSessions owned by the configured Telegram channel account', async () => {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeSession('kcs-match', 'telegram-work', 'work', 'telegram'),
          makeSession('kcs-other-channel', 'telegram-home', 'work', 'telegram'),
          makeSession('kcs-other-account', 'telegram-work', 'home', 'telegram'),
          makeSession('kcs-other-provider', 'telegram-work', 'work', 'whatsapp'),
          { apiVersion: 'kagent.knuteson.io/v1alpha1', kind: 'ConfigMap' },
        ],
      }),
    };
    const store = buildKubernetesChannelOutboxStore({ customApi: customApi as never });

    const sessions = await store.listChannelSessions({
      namespace: 'kagent-system',
      channelName: 'telegram-work',
      accountId: 'work',
    });

    expect(sessions.map((session) => session.metadata.name)).toEqual(['kcs-match']);
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace: 'kagent-system',
      plural: 'channelsessions',
    });
  });

  it('gets AgentTasks by ChannelSession task ref', async () => {
    const task = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: { name: 'kat-turn-1', namespace: 'kagent-system' },
      spec: { payload: {} },
      status: { phase: 'Completed', result: { content: 'ok' } },
    };
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(task),
    };
    const store = buildKubernetesChannelOutboxStore({ customApi: customApi as never });

    await expect(
      store.getAgentTask({ namespace: 'kagent-system', name: 'kat-turn-1' }),
    ).resolves.toEqual(task);
    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace: 'kagent-system',
      plural: 'agenttasks',
      name: 'kat-turn-1',
    });
  });

  it('merge-patches ChannelSession.status for outbound delivery state', async () => {
    const customApi = {
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const store = buildKubernetesChannelOutboxStore({ customApi: customApi as never });

    await store.patchSessionStatus('kagent-system', 'kcs-match', {
      phase: 'Active',
      lastOutboundAt: '2026-06-12T12:00:00.000Z',
      lastOutboundTaskRef: { namespace: 'kagent-system', name: 'kat-turn-1' },
      consecutiveFailures: 0,
      backoffUntil: null,
      lastFailureReason: null,
    });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'channelsessions',
        name: 'kcs-match',
        body: {
          status: {
            phase: 'Active',
            lastOutboundAt: '2026-06-12T12:00:00.000Z',
            lastOutboundTaskRef: { namespace: 'kagent-system', name: 'kat-turn-1' },
            consecutiveFailures: 0,
            backoffUntil: null,
            lastFailureReason: null,
          },
        },
      },
      expect.any(Object),
    );
  });
});

function makeSession(
  name: string,
  channelName: string,
  accountId: string,
  provider: string,
): unknown {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ChannelSession',
    metadata: { name, namespace: 'kagent-system' },
    spec: {
      channelRef: { name: channelName },
      provider,
      accountId,
      peer: { kind: 'dm', id: '3175140114' },
      sessionKey: 'session-key',
      target: { agentRef: { name: 'operator-investigator' } },
    },
  };
}
