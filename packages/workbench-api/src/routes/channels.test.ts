/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  API_GROUP_VERSION,
  type AgentTask,
  type Channel,
  type ChannelBinding,
  type ChannelSession,
} from '@kagent/dto';

import { SnapshotCache } from '../cache.js';
import { channelsRoute } from './channels.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Channel',
    metadata: {
      name: 'whatsapp-work',
      namespace: 'kagent-system',
      generation: 3,
      creationTimestamp: new Date('2026-06-12T10:00:00Z'),
      ...overrides.metadata,
    },
    spec: {
      provider: 'whatsapp',
      accountId: 'work',
      displayName: 'Work WhatsApp',
      paused: false,
      policy: {
        dmPolicy: 'pairing',
        allowFrom: ['+15551234567'],
        groupPolicy: 'disabled',
        groups: ['ops-room@g.us'],
      },
      sessionStorage: {
        pvc: { claimName: 'kagent-kagent-operator-channel-whatsapp-auth' },
      },
      whatsapp: { authDir: '/auth', sendReadReceipts: true },
      ...overrides.spec,
    },
    status: {
      phase: 'Pairing',
      observedGeneration: 3,
      pairing: {
        state: 'qr',
        qrCode: 'sensitive-qr-data',
        pairingCode: 'sensitive-pairing-code',
        expiresAt: '2026-06-12T10:05:00Z',
        message: 'scan pending',
      },
      lastHeartbeatAt: '2026-06-12T10:01:00Z',
      activeSessionCount: 1,
      ...overrides.status,
    },
  };
}

function makeBinding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelBinding',
    metadata: {
      name: 'whatsapp-work-operator-investigator',
      namespace: 'kagent-system',
      ...overrides.metadata,
    },
    spec: {
      channelRef: { name: 'whatsapp-work' },
      default: true,
      target: {
        agentRef: { name: 'operator-investigator' },
        modelClass: 'tool-caller-default',
        runConfig: { timeoutSeconds: 600, maxIterations: 6 },
        session: { scope: 'per-account-channel-peer' },
      },
      approval: { required: false, mode: 'operator' },
      ...overrides.spec,
    },
    status: {
      lastMatchedAt: '2026-06-12T10:02:00Z',
      ...overrides.status,
    },
  };
}

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelSession',
    metadata: {
      name: 'kcs-whatsapp-work-a1b2c3d4',
      namespace: 'kagent-system',
      ...overrides.metadata,
    },
    spec: {
      channelRef: { name: 'whatsapp-work' },
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'dm', id: '+15551234567' },
      threadId: 'direct',
      sessionKey: 'agent:operator-investigator:channel:whatsapp-work:account:work:dm:+15551234567',
      bindingRef: { name: 'whatsapp-work-operator-investigator' },
      target: { agentRef: { name: 'operator-investigator' } },
      ...overrides.spec,
    },
    status: {
      phase: 'Active',
      lastInboundAt: '2026-06-12T10:03:00Z',
      lastOutboundAt: '2026-06-12T10:04:00Z',
      lastTaskRef: {
        namespace: 'kagent-system',
        name: 'channel-turn-abc',
        uid: 'task-uid',
      },
      ...overrides.status,
    },
  };
}

function makeTask(): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: 'channel-turn-abc',
      namespace: 'kagent-system',
      uid: 'task-uid',
    },
    spec: { targetAgent: 'operator-investigator', payload: {} },
    status: { phase: 'Completed' },
  };
}

describe('channelsRoute', () => {
  it('lists channels with sanitized pairing status and joined counts', async () => {
    const cache = new SnapshotCache();
    cache.upsertChannel(makeChannel());
    cache.upsertChannelBinding(makeBinding());
    cache.upsertChannelSession(makeSession());

    const res = await channelsRoute({ cache }).request('/api/channels');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly items: readonly {
        readonly name: string;
        readonly namespace: string;
        readonly provider: string;
        readonly accountId: string;
        readonly phase?: string;
        readonly pairing?: {
          readonly state?: string;
          readonly qrAvailable: boolean;
          readonly pairingCodeAvailable: boolean;
          readonly qrCode?: string;
          readonly pairingCode?: string;
        };
        readonly policy: {
          readonly dmPolicy: string;
          readonly allowFrom: readonly string[];
          readonly groupPolicy: string;
          readonly groups: readonly string[];
        };
        readonly bindingCount: number;
        readonly sessionCount: number;
      }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: 'whatsapp-work',
      namespace: 'kagent-system',
      provider: 'whatsapp',
      accountId: 'work',
      phase: 'Pairing',
      policy: {
        dmPolicy: 'pairing',
        allowFrom: ['+15551234567'],
        groupPolicy: 'disabled',
        groups: ['ops-room@g.us'],
      },
      bindingCount: 1,
      sessionCount: 1,
    });
    expect(body.items[0]?.pairing).toMatchObject({
      state: 'qr',
      qrAvailable: true,
      pairingCodeAvailable: true,
    });
    expect(body.items[0]?.pairing?.qrCode).toBeUndefined();
    expect(body.items[0]?.pairing?.pairingCode).toBeUndefined();
  });

  it('returns channel detail with bindings and sessions joined to last task state', async () => {
    const cache = new SnapshotCache();
    cache.upsertChannel(makeChannel());
    cache.upsertChannelBinding(makeBinding());
    cache.upsertChannelSession(makeSession());
    cache.upsertTask(makeTask());

    const res = await channelsRoute({ cache }).request('/api/channels/kagent-system/whatsapp-work');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly bindings: readonly {
        readonly name: string;
        readonly target: {
          readonly agentRef?: string;
          readonly runConfig?: Record<string, number>;
        };
      }[];
      readonly sessions: readonly {
        readonly name: string;
        readonly phase?: string;
        readonly peer: { readonly kind: string; readonly id: string };
        readonly lastTask?: {
          readonly namespace: string;
          readonly name: string;
          readonly phase?: string;
          readonly ui: string;
        };
      }[];
    };
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0]?.name).toBe('whatsapp-work-operator-investigator');
    expect(body.bindings[0]?.target.agentRef).toBe('operator-investigator');
    expect(body.bindings[0]?.target.runConfig).toEqual({
      timeoutSeconds: 600,
      maxIterations: 6,
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.name).toBe('kcs-whatsapp-work-a1b2c3d4');
    expect(body.sessions[0]?.phase).toBe('Active');
    expect(body.sessions[0]?.peer).toEqual({ kind: 'dm', id: '+15551234567' });
    expect(body.sessions[0]?.lastTask).toMatchObject({
      namespace: 'kagent-system',
      name: 'channel-turn-abc',
      phase: 'Completed',
      ui: '/#/tasks/kagent-system/channel-turn-abc',
    });
  });

  it('patches channel paused state through the gated write surface', async () => {
    const cache = new SnapshotCache();
    cache.upsertChannel(makeChannel());
    const patchNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const app = channelsRoute({
      cache,
      customApi: { patchNamespacedCustomObject } as never,
      writesEnabled: true,
      defaultNamespace: 'kagent-system',
    });

    const res = await app.request('/api/channels/kagent-system/whatsapp-work', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'channels',
        name: 'whatsapp-work',
        body: { spec: { paused: true } },
      },
      expect.anything(),
    );
  });

  it('rejects channel mutation when writes are disabled or namespace is outside the release', async () => {
    const cache = new SnapshotCache();
    cache.upsertChannel(makeChannel());

    const disabled = await channelsRoute({ cache }).request(
      '/api/channels/kagent-system/whatsapp-work',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      },
    );
    expect(disabled.status).toBe(503);

    const forbidden = await channelsRoute({
      cache,
      customApi: { patchNamespacedCustomObject: vi.fn() } as never,
      writesEnabled: true,
      defaultNamespace: 'kagent-system',
    }).request('/api/channels/other/whatsapp-work', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    expect(forbidden.status).toBe(403);
  });
});
