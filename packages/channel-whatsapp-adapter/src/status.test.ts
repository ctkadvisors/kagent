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
      channelName: 'whatsapp-work',
    });

    await patcher.patch({
      phase: 'Pairing',
      pairing: { state: 'qr', qrCode: 'qr-data' },
    });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'channels',
        name: 'whatsapp-work',
        body: { status: { phase: 'Pairing', pairing: { state: 'qr', qrCode: 'qr-data' } } },
      },
      expect.any(Object),
    );
  });
});

describe('buildKubernetesChannelOutboxStore', () => {
  it('lists only ChannelSessions owned by the configured WhatsApp channel account', async () => {
    const customApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeSession('kcs-match', 'whatsapp-work', 'work'),
          makeSession('kcs-other-channel', 'whatsapp-home', 'work'),
          makeSession('kcs-other-account', 'whatsapp-work', 'home'),
          { apiVersion: 'kagent.knuteson.io/v1alpha1', kind: 'ConfigMap' },
        ],
      }),
    };
    const store = buildKubernetesChannelOutboxStore({ customApi: customApi as never });

    const sessions = await store.listChannelSessions({
      namespace: 'kagent-system',
      channelName: 'whatsapp-work',
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

function makeSession(name: string, channelName: string, accountId: string): unknown {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ChannelSession',
    metadata: { name, namespace: 'kagent-system' },
    spec: {
      channelRef: { name: channelName },
      provider: 'whatsapp',
      accountId,
      peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
      sessionKey: 'session-key',
      target: { agentRef: { name: 'operator-investigator' } },
    },
  };
}
